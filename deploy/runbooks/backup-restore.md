# Runbook — Backup y restore

Dos cosas se respaldan y **no viajan juntas**:

| Qué | Dónde | Qué pasa si se pierde |
|---|---|---|
| La **base de control** (`tourniquet`) | Plan de mantenimiento de SQL Server | Se puede restaurar |
| La **master key** (`TQ_MASTER_KEY`) | Gestor de secretos del cliente, en un **lugar y con una persona** | **No hay restore posible** |

La segunda fila es la que cuesta. Un backup de la base sin la master key es un
backup de ciphertext: se restaura, las tablas se ven, y **ninguna clave privada, ni
ningún secreto de MFA, ni ninguna credencial de base de negocio se puede descifrar**.

---

## 1 · La base de control

Motor: **SQL Server**. Un plan de mantenimiento, con su propia copia.

| Tipo | Frecuencia | Por qué esa |
|---|---|---|
| **Full** | Semanal | La base es chica: 14 tablas y el crecimiento es de sesiones. Una full semanal pesa poco |
| **Diferencial** | Diaria | Cubre lo que cambió desde la full |
| **Log** | Cada 15 minutos | **Solo si el cliente lo pide.** El `RPO` real del producto son los 15 minutos de vida del access token, y **una pérdida de 15 minutos de sesiones es tolerable**: el peor caso es que alguien tenga que volver a entrar. El backup es de datos, no de disponibilidad |
| **Copia de la base `master`** | Una vez, al instalar | Solo para poder reconstruir si alguien borra la base por error. Una vez, y basta |

> **El log cada 15 minutos no es el default, y la razón es esta.** Tourniquet
> guarda sesiones y auditoría, no datos de negocio: lo que se pierde en una
> ventana de backup es un bunch de sesiones abiertas, que vuelven a loguearse. El
> backup importa por `idn_usuario` (quién tiene acceso) y por `aud_login` (el
> registro de accesos), y esas tablas crecen muy despacio. Se ofrece igual porque
> hay clientes con requisitos de continuidad, pero es una decisión del cliente y
> tiene que quedar escrita como tal.

### Cómo se agenda

**SQL Server completo** → un *Maintenance Plan* con las tareas *Full Backup*,
*Incremental Backup* y *Transaction Log Backup*, apuntando a una carpeta del
servidor o a un share. Con `Verify = true` y `Compress = true`.

**SQL Server Express** (no tiene Agente) → el *Planificador de tareas de Windows*
con `sqlcmd`:

```cmd
sqlcmd -S SQL-CERVI -U sa -P %TORN_SQL_PWD% -d tourniquet -b ^
  -Q "BACKUP DATABASE [tourniquet] TO DISK = N'C:\Backups\tourniquet.bak' WITH INIT, COMPRESSION, VERIFY"
```

Con la contraseña en el **administrador de credenciales de la tarea**, no en el
argumento. Un `-P` en la línea de comandos queda en la lista de procesos de la
máquina.

### Dónde van las copias

**Nunca en el mismo servidor y en el mismo disco.** Un plan de backup que escribe
en `C:\` del servidor cuyo disco se lleno no es un plan de backup, es una copia de
archivos que se pierden junto con la base.

| Dónde | Sirve para |
|---|---|
| Share de red de otro servidor, con retención | **El respaldo principal.** Un disco más, una máquina más |
| Copia offline, en otro edificio | Contra ransomware que cifra los shares |
| Nube (blob, S3-equivalente) | Contra que se caiga el edificio. **Cifrado del lado del cliente**: el backup contiene hashes de claves y credenciales cifradas |

**La retención la define el cliente y hay que anotarla.** Mínimo: el más viejo que
pueda necesitar un restore tiene que existir, y el más reciente tiene que estar
completo.

---

## 2 · La master key

**No va en el backup de la base.** Va en el gestor de secretos del cliente, y de
ahí a una segunda copia.

En el acta de instalación quedan **tres** cosas escritas, y sin las tres el
runbook no está completo:

1. **Dónde** está la copia de la master key. Un gestor de secretos **con su
   propio respaldo**, en un sistema distinto del de producción.
2. **Quién** la tiene: nombre, no "el equipo de sistemas".
3. **Cuándo se probó** que la copia sirve: el paso 3 lo dice.

> **La copia tiene que estar en un sistema distinto**, no en otro archivo del mismo
> gestor ni en el mismo servidor. El escenario que hay que cubrir es "perdimos el
> servidor del gestor de secretos", y una copia en el mismo lugar no lo cubre.

### Por qué no se puede recuperar

`TQ_MASTER_KEY` es la clave de la que salen, con AES-256-GCM:

- Las claves privadas RSA de firma (`tok_clave_firma.llave_cifrada`).
- Los secretos de MFA (`idn_usuario_mfa.secreto_cifrado`).
- Las credenciales de las bases de negocio (`cat_base_datos.credencial_cifrada`).

GCM es autenticado: **no hay forma de distinguir "cifrado con la clave correcta" de
"cifrado con cualquier otra" sin tener la clave**. No hay KDF, ni salt, ni
"prueba de recuperacion" parcial. Sin la master key, esas columnas son bytes.

Y no hay recuperación parcial: la clave de firma se puede regenerar (eso es lo que
hace `npm run generar:clave` más un `bootstrap:admin`), **pero** las credenciales
de las bases de negocio hay que volver a escribir una por una, con la persona
delante. Por eso el procedimiento de pérdida de master key **no se improvisa**: es
una fase, con su propio plan.

---

## 3 · El restore se prueba, no se supone

> **Un backup no probado no es un backup.** Es un archivo con una fecha.

Al menos **una vez antes de dar por cerrada la instalación**, y una vez al año:

1. Crear una base vacía con otro nombre: `tourniquet_restore`. **Nunca** sobre la
   de producción: un restore sobre el nombre real pisa la instalación viva, y con
   la base de control eso es borrar la identidad de la empresa.

   ```sql
   CREATE DATABASE [tourniquet_restore];
   ```

2. Restaurar el backup más reciente encima.
3. **Con la master key** en el entorno, correr la prueba de humo de
   `instalacion.md` §12 **contra esa copia**, apuntando `DATABASE_URL` a
   `tourniquet_restore`.
4. Lo que tiene que funcionar, y no se puede levantar sin la master key:

   ```bash
   # El JWKS tiene que exponer una clave activa.
   npm run verificar:clave

   # Y el login tiene que entrar: si el JWKS expone, la clave privada se
   # descifro con la master key correcta.
   npm run verificar:oidc
   ```

5. **Borrar la base de prueba** y anotar fecha, hora, qué backup y qué pasó.

> El paso 4 es el que prueba lo importante. Un restore que se levanta y muestra
> tablas **no probó la master key**: las tablas se ven con la clave que sea. Lo que
> prueba la clave es que el backend pueda **descifrar** la clave de firma y **firmar**
> un token. `verificar:clave` y `verificar:oidc` son exactamente eso.

### Lo que el restore NO prueba

- Que la copia sea **completa**: una copia parcial también restaura "bien" y falla
  recién cuando faltan datos. Por eso `VERIFY` en el backup y el `99` de esquema.
- Que la **master key** siga en su sitio. Es un paso aparte, con su fecha, y con la
  copia **en la mano** (abrir el gestor, leerla, compararla) — no "está configurada
  en el servicio".

---

## 4 · Qué se restaura y qué no

| Se restaura con el plan de la base | No se restaura (o no tiene sentido) |
|---|---|
| `idn_usuario` (quién tiene acceso) | La master key — está en el gestor |
| `idn_usuario_cliente*` (pertenencias, apps) | `base_datos.host` de una base que cambió de servidor: se actualiza, no se restaura |
| `tok_sesion` (quién está adentro ahora) | El `.env` del servidor: se reconstruye con el gestor de secretos |
| `aud_login` (append-only, 2 años) | La clave de firma: se regenera si se restauró de un backup viejo |
| `cat_*` (clientes, apps, bases) | |

> **Restaurar un backup viejo hace retroceder la clave de firma.** Después de un
> restore a un backup anterior a la última rotación, el JWKS publica la clave nueva
> y los tokens firmados con la vieja dejan de validar. Consecuencia: **todas las
> sesiones abiertas de ese momento se caen y hay que volver a loguear**, y
> cualquier app que haya cacheado el JWKS viejo tiene que refrescarlo
> (`POST /auth/rotate-jwks` en RHPro, `specs/03`).
>
> Por eso un restore es un **acto de mantenimiento**: se avisa, se hace en horario de
> baja actividad, y se cuentan los pasos 4 y 5 de la prueba de humo de
> `instalacion.md` **contra la copia restaurada**, no contra la base que después se
> pone en producción.

---

## 5 · Restaurar un job perdido

Distinto del restore de disaster:

1. Los cuatro jobs son T-SQL puro de `deploy/sql/`, idempotentes, sin `USE`, y se
   re-agendan con el mismo procedimiento de `jobs-limpieza.md`.
2. **No se necesita `TQ_MASTER_KEY`.** Son `DELETE` acotados por fecha sobre la base
   de control y no hablan con la aplicación. La cuenta que los corre es otra, con
   menos permisos que la de la app.
3. Verificar que el historial diga lo que tiene que decir:

   ```sql
   -- En SQL Agent:
   SELECT name, last_run_status, last_run_date FROM msdb.dbo.sysjobs
   WHERE name LIKE 'Tourniquet%';
   ```

---

## 6 · La lista de la instalación

Esto se anota en el acta **antes** de dar por cerrada la instalación:

- [ ] Plan de backup agendado y **una corrida completa vista en el log**.
- [ ] Retención definida y escrita.
- [ ] Copia de la master key **en un sistema distinto**, con **una persona nombrada**.
- [ ] **Restore probado** en una base aparte, con la prueba de humo y con
      `verificar:oidc`, con fecha y con qué backup se probó.
- [ ] Base de restore **borrada** después de la prueba.
- [ ] Fecha del próximo restore probado (anual, en el acta).
