# Runbook — Jobs de limpieza y retención

Motor: **SQL Server**. Los cuatro scripts son T-SQL puro de `deploy/sql/` y los
**crea y agenda el usuario**. La app nunca borra nada de esto (invariante de
`AGENTS.md`, `specs/01` §7): son `DELETE`/`UPDATE` acotados por fecha, ejecutados
fuera del proceso del backend.

| Script | Qué hace | Frecuencia |
|---|---|---|
| `95-job-codigos.sql` | Borra `tok_autorization_code` vencido hace **más de 1 día** y `tok_mfa_challenge` vencido | cada 5 min |
| `96-job-refresh.sql` | Borra `tok_refresh_token` **revocado** hace más de **90 días** | diaria |
| `97-job-auditoria.sql` | Borra `aud_login` con `ts` de más de **2 años** | mensual |
| `98-job-sesiones.sql` | **Marca** `cerrada_en`/`motivo_cierre='expirada'` en las sesiones vencidas. No borra | cada hora |

> **Por qué el 90 borra los *revocados* y no los *vencidos*.** Un refresh que expiró
> solo se conserva: es la evidencia de que esa sesión existió, y el `replay` de una
> familia de refresh se detecta justamente contra la fila del token viejo. Si el job
> borrara por `expira_en`, la investigación de un robo tendría menos datos cuanto más
> viejo fuera. Ver `specs/01` §7.1.

---

## Cómo se agendan: dos variantes, un mismo SQL

La decisión de cuál usar la toma el **motor** de la instalación, no el operador:

| Motor del cliente | Agendador | Cómo |
|---|---|---|
| SQL Server **completo** (Standard, Enterprise…) | **SQL Agent** | Un trabajo por `.sql`, con su propia frecuencia |
| **SQL Server Express** — no tiene SQL Agent | **Planificador de tareas de Windows** | Una tarea que corre `deploy/jobs/ejecutar-jobs.cmd` |

Los `.sql` son los mismos, son idempotentes y no llevan `USE`, así que funcionan en
las dos variantes sin cambio alguno. Lo que **no** cambia entre las dos es la regla de
que el borrado lo hace un `.sql` versionado, fuera de la app.

### Variante A — SQL Agent (motor completo)

Es la recomendada si hay Agente: permite **frecuencias distintas por job**, que con
el ejecutor único se aproximan pero no se alcanzan (el `95` necesita cada 5 minutos y
el `97` una vez al mes).

1. **SSMS → SQL Server Agent → Jobs → New Job**.
2. **Steps → New Step**, tipo *Transact-SQL script*:
   - **Database:** `tourniquet`.
   - **Command:**

     ```sql
     :r ..\sql\95-job-codigos.sql
     ```

   - Si `sqlcmd` no resuelve las rutas relativas, usar la ruta absoluta al `.sql`.
3. **Schedule → New**, con la frecuencia de la tabla de arriba.
4. Nombre del trabajo: `Tourniquet · 95 codigos` (el `·` en el nombre del job es
   solo para el visor; si el Agente no lo acepta, `Tourniquet - 95 codigos`).

Para los jobs **mensuales** (el 97) agregar en *Owner → Job Step Properties → Advanced*
`@monthly` en el campo de periodicidad. Es el único paso que la frecuencia mensual
exige y es donde se olvida la mitad de las veces.

#### Verificación del Agente

- El **historial del paso** tiene que mostrar `Succeeded` y el log de SQL Server
  tiene que traer los `PRINT` de la sección de verificación de cada `.sql`.
- Un trabajo en `Succeeded` con un `DELETE` que no corrió es posible si el paso no
  tenía `-b`-equivalente: en SQL Agent el paso se marca fallido ante un error de SQL
  automáticamente, pero **no** si el `.sql` termina con un `PRINT` de error. Por eso
  los `.sql` no esconden fallos: si el `DELETE` falla, el paso para ahí.
- Para una prueba sin esperar: correr el `.sql` a mano en SSMS sobre `tourniquet_dev` y
  mirar la sección `--- VERIFICACION · NN · ... ---`.

### Variante B — Planificador de tareas de Windows (SQL Server Express)

1. **Preparar la conexión.** El ejecutor usa, por defecto, **autenticación
   integrada** (`-E`): la cuenta de la tarea entra con su token de Windows y no hay
   ninguna contraseña escrita en un archivo ni en la línea de comandos. Eso requiere
   que la cuenta tenga un login de SQL:

   ```sql
   -- Una vez, con un login de Windows del dominio o local (ajustar el nombre).
   USE master;
   CREATE LOGIN [DOMINIO\svc_tourniquet] FROM WINDOWS;
   USE tourniquet;
   CREATE USER [DOMINIO\svc_tourniquet] FOR LOGIN [DOMINIO\svc_tourniquet];
   -- db_datawriter alcanza: INSERT/UPDATE/DELETE sobre las tablas de la base.
   ALTER ROLE db_datawriter ADD MEMBER [DOMINIO\svc_tourniquet];
   ```

   **No** darle `db_owner` ni `sysadmin`: los jobs sólo ejecutan cuatro sentencias
   con `WHERE` de fecha, y una cuenta con menos permisos no puede romper nada aunque
   el `.sql` se edite mal.

2. **Probar el ejecutor a mano, desde una consola**, antes de agendar nada:

   ```bat
   set TQ_JOB_SQL_SERVER=SERVIDOR\INSTANCIA
   set TQ_JOB_SQL_BASE=tourniquet
   deploy\jobs\ejecutar-jobs.cmd
   ```

   Salida esperada: los cuatro jobs con `OK.` y un resumen `RESULTADO: los jobs
   ejecutados terminan bien`. Los logs quedan en
   `%ProgramData%\Tourniquet\jobs\log\`.

   - `No se encontro sqlcmd.exe` → instalar las *Microsoft Command Line Utilities
     for SQL Server* o el *ODBC Driver for SQL Server*, o agregar `Tools\Binn` al
     `PATH` de la tarea. El ejecutor ya busca en las rutas de las versiones 130 a 170.
   - `Falta TQ_JOB_SQL_SERVER` → falta la variable en el paso de la tarea.

3. **Crear la tarea** (Programador de tareas → Crear tarea, no el asistente básico):

   | Campo | Valor |
   |---|---|
   | **General / Ejecutar como** | La cuenta de servicio del punto 1 (*independientemente de que el usuario haya iniciado sesión*) |
   | **General / No iniciar a pedido** |que arranque sola: marcar, **no** usuario |
   | **Desencadenadores / Nuevo** | Diariamente → **repetir cada 1 minuto**, durante **1 día** |
   | **Acciones / Nueva** | Iniciar un programa |
   | **Programa/script** | `cmd.exe` |
   | **Agregar argumentos** | `/c "D:\ruta\tourniquet\deploy\jobs\ejecutar-jobs.cmd"` |
   | **Iniciar en** | La carpeta que contiene `deploy\jobs\` |

   - **Una sola tarea con repetición cada minuto** cubre las cuatro frecuencias: el
     ejecutor es barato cuando no hay nada que borrar (dos `COUNT` y un `DELETE` de
     cero filas), y la alternativa —cuatro tareas con disparadores distintos— multiplica
     por cuatro la superficie de configuración. El costo real es de CPU de SQL Server,
     no de disco.
   - Si el servidor es **`localhost`**, la tarea tiene que correr como
     `SYSTEM` o ser la misma cuenta del Agente, porque Windows no permite que una
     cuenta sin privilegios interactúe con el servicio SQL de otra cuenta.

4. **Verificar desde el historial**: *Historial → Todas las ejecuciones*. Cada corrida
   debe terminar con *La tarea se completó correctamente* (código 0). Un `3` significa
   que un job falló, y el log con el detalle está en el directorio de logs.

### Frecuencias: por qué el ejecutor único es una aproximación

| Job | SQL Agent (frecuencia real) | Tarea de Windows (aproximación) |
|---|---|---|
| `95` códigos y desafíos | cada 5 minutos | cada 1 minuto (sobredimensionado a propósito) |
| `96` refresh | diaria | cada minuto | 
| `97` auditoría | mensual | **cada minuto, todos los días** |
| `98` sesiones | cada hora | cada minuto |

El `97` corriendo cada minuto no es un problema —`DELETE` de cero filas— pero **sí**
es una razón para la variante A si la instalación es grande: el job recorre
`aud_login` (que es la tabla más grande de la base) en cada pasada. Si la tabla pasa
de ~500 mil filas, la instalación necesita SQL Agent o un segundo ejecutor con su
propio disparador.

En `96` y `97` el `.sql` imprime el **límite de retención** y el **número de filas
que va a borrar** antes de borrar. Ese número es el que hay que mirar en la primera
corrida de la instalación.

---

## Orden de aplicación en una instalación nueva

1. `00-crear-base.sql` (crea la base y las 14 tablas).
2. `03-mfa-segundo-factor.sql` (sólo si la base venía de antes de la Fase 09).
3. La semilla del cliente: `scripts/generar-instalacion.mjs`.
4. `scripts/bootstrap-admin.mjs`.
5. **Los jobs**, con este runbook.

`95-` a `98-` **no** se aplican a mano como parte de la instalación: se agendan. Un
job de retención que se corre una vez a mano es un job que se olvidó.

---

## Qué hacer si un job falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `95` falla con Violación de FK | Se editó el `.sql` y se le olvidó el filtro | Restaurar el archivo del repo. **No** desactivar la constraint |
| `97` falla por el log lleno | `aud_login` grande y el `DELETE` en lotes de 5000 con muchos lotes abiertos | Correr de nuevo: es idempotente y sigue avanzando |
| Los jobs devuelven 0 filas borradas en la primera corrida | Instalación nueva: no hay nada vencido todavía | Normal. No es un fallo |
| La tarea de Windows termina con código 3 | Un `.sql` devolvió error | El log del job dice cuál; `deploy/sql/9N-*.sql` tiene la sección `--- VERIFICACION` |
| El job 95 no se ejecuta | La cuenta de la tarea perdió los permisos tras un cambio de contraseña de dominio | Volver a probar el paso 2 (correr el ejecutor a mano con esa cuenta) |

---

## Relación con la app

- La app **nunca** borra auditoría, ni codes, ni refresh, ni sesiones: no hay un
  endpoint que lo haga y `AuditoriaService` no expone `update` ni `delete`.
- Los índices que sostienen estos jobs son `IX_tok_autorization_code(expira_en)`,
  `IX_tok_refresh_token(expira_en) WHERE revocado_en IS NULL`,
  `IX_tok_mfa_challenge(expira_en)`, `IX_aud_login(ts)` — declarados en
  `specs/02` §4 y creados por `00-crear-base.sql`/`03-`.
- Cambiar la retención (por ejemplo, a 5 años por contrato de cliente) es cambiar
  `97-job-auditoria.sql` **y** la línea de `specs/01` §7.1. No es un parámetro de
  entorno: una retención que se puede cambiar sin dejar rastro en el repo es una
  retención que un día se cambia por error.
