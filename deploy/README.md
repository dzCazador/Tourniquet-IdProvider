# `deploy/` — SQL de la base de control

La base de control de Tourniquet es **una base propia y separada** (`tourniquet` en producción,
`tourniquet_dev` en desarrollo) con las 12 tablas `cat_*` / `idn_*` / `tok_*` / `aud_*`. No comparte esquema con las bases de
negocio de las apps: Tourniquet no se conecta a ellas, sólo las registra como inventario
(D3 de `specs/00-arquitectura.md`).

**Motor único: SQL Server / T-SQL.** Todo lo de `deploy/sql/` está escrito para Microsoft SQL
Server y no se abstrae: es legítimo usar `datetime2`, `sysutcdatetime()`, índices filtrados con
`WHERE`, `TOP`, `ON DELETE NO ACTION` y compañía. No hay variantes `.mysql.sql` a diferencia de
RHPro, y **no se escribe SQL "portable" a propósito** (`AGENTS.md` regla 2).

Si algún día hace falta otro motor, se crean **archivos scripts nuevos y propios** para ese motor
en ese momento, con su numeración y su verificador, y se documenta la decisión en `specs/02`.
No se generan ahora, no se adivinan y no se "porta" lo existente.

`multibase` acá significa **varias bases SQL Server** (una por cliente), no varios motores.

> **Trampa de T-SQL, ya tropezada:** en una FK la palabra es `ON DELETE NO ACTION`, no
> `ON DELETE RESTRICT`. `RESTRICT` es del SQL estándar y existe en MySQL/Postgres, pero en T-SQL
> es error de sintaxis, y el fallo se propaga: la tabla con esa FK no se crea y todo lo que la
> referencia después falla con "no existe". Cuando una tabla falte en la salida, revisar primero
> los errores de sintaxis que la anteceden.

---

## Los dos caminos

El esquema se puede construir de dos maneras, y tienen que dar **el mismo resultado**:

```
(A)  00-crear-base.sql                                          -> esquema completo
(B)  00-crear-base.sql + 01-*.sql + 02-*.sql + ... + 90-*.sql  -> mismo esquema
```

- **(A) es el camino de instalación**: una base nueva, en una máquina nueva, la levanta un solo
  archivo. Se usa en la Fase 10 (instalación de un cliente) y para reconstruir una base.
- **(B) es el camino de evolución**: una base que ya está en producción va tomando incrementales
  de a un cambio, sin recrearse.

`99-verificar-esquema.sql` imprime la huella del esquema para comparar (A) contra (B).

---

## La regla que hace cumplible esto

> **Todo cambio de esquema se entrega en dos archivos y en el mismo commit:**
> 1. el incremental `NN-<cambio>.sql`, para las bases que ya están instaladas;
> 2. la actualización de `00-crear-base.sql`, para las que se crean nuevas.

Si divergen, es un defecto. La divergencia se detecta tarde, en la instalación de un cliente
que no tiene el último cambio, y ahí el que la descubre es el cliente. Por eso la verificación
de la fase (`99-verificar-esquema.sql`) compara los dos caminos y tiene que dar **cero
diferencias**.

Copia `_plantilla-incremental.sql` para escribir un nuevo incremental. La plantilla documenta las
reglas: idempotencia, numeración, qué no va en un `.sql`.

---

## Inventario

| Archivo | Qué es | Quién lo ejecuta |
|---|---|---|
| `00-crear-base.sql` | Crea la base si no existe + las 12 tablas + índices. Estado completo y vigente | **El usuario** (crea bases) |
| `_reset-dev.sql` | **DESTRUCTIVO.** Borra la base de desarrollo (MDF y LDF incluidos) y la deja vacía. Sólo para probar el esquema desde cero | **El usuario**, con `-v CONFIRMAR="BORRAR"` |
| `_plantilla-incremental.sql` | Guía de cómo se escribe un incremental. **No se ejecuta** | — |
| `90-semilla-catalogo.sql` | Catálogo: apps, clientes, vínculos e inventario de bases (4 de RHPro). Sin usuarios, sin credenciales | Agente (sólo dev) o usuario |
| `99-verificar-esquema.sql` | Imprime la huella del esquema para comparar los caminos (A) y (B) | Cualquiera (es de sólo lectura) |

Los archivos con `_` inicial no se ejecutan nunca en automático: son guías o, en el caso de
`_reset-dev.sql`, herramientas de desarrollo.

### Cómo probar el esquema desde cero

`00-crear-base.sql` es **idempotente**: cada `CREATE TABLE` e `CREATE INDEX` está guardado con
`IF OBJECT_ID IS NULL` / `IF NOT EXISTS`. Correrlo de nuevo sobre una base a medio construir
completa lo que falta y no toca lo que ya está. Para la mayoría de los casos, eso alcanza y es
más rápido que borrar.

Cuando de verdad querés empezar de cero —probar el `00` completo, o deshacer una base de
desarrollo a la que se le colaron datos de prueba— usá el reset:

1. Abrí `deploy/sql/_reset-dev.sql` y poné `@confirmar` en `N'BORRAR'` (y `@base` en la base que
   quieras, `tourniquet_dev` por defecto).
2. Corré el archivo entero, desde una consulta nueva — **no** desde la base que se va a borrar.
3. Dejá `@confirmar` en `N''` de nuevo, para que no pueda dispararse por accidente.

```bash
# o con sqlcmd, apuntando a master para no estar parado sobre la base a borrar
sqlcmd -S <srv> -U <usr> -P <pwd> -d master -b -i deploy/sql/_reset-dev.sql
```

- Sin `@confirmar = N'BORRAR'` el script aborta antes de tocar nada.
- **El `DROP DATABASE` borra los `.mdf` y `.ldf` con la base**: no hay que borrarlos a mano.
  Quedan huérfanos sólo si un `DROP` anterior falló a mitad o la base fue detach sin borrar; en
  ese caso se borran a mano desde `MSSQL*/DATA/`, y sólo los de esa base.
- **Todos los `.sql` de `deploy/sql/` son T-SQL puro**, sin directivas de sqlcmd (`:setvar`,
  `:r`, `:on error`). Corre igual en sqlcmd, SSMS y Azure Data Studio. Si se abre desde el
  editor, una directiva `:` llega al motor como SQL y da error de sintaxis.

**Por qué el `DROP` no está dentro de `00-crear-base.sql`:** ese archivo es el camino de
instalación y se corre en producción (Fase 10). Si llevara un `DROP` al principio, el día que
alguien lo corra contra `tourniquet` —el IdP de un cliente, con sus usuarios y sus apps— borra
el IdP entero. Un script de creación que puede borrar la base que está por crear no es un
script de creación.

**Los incrementales `01-` a `89-` no existen todavía**: la base se crea por primera vez con el
`00-crear-base.sql`, así que todavía no hubo ningún cambio que se haya. El primero que aparezca en
el historial del repo es el primero de la serie. Un número retirado no se reutiliza nunca: una
base que aplicó el `07` no puede recibir después un `07` distinto.

### Numeración

| Rango | Qué va |
|---|---|
| `00-` | Creación desde cero. Uno solo, siempre completo |
| `01-` … `89-` | Incrementales de esquema. **Un cambio por archivo, en orden** |
| `90-` … `94-` | Semillas de catálogo (no sensibles) |
| `95-` … `98-` | Jobs de limpieza y retención |
| `99-` | Verificación |

---

## Por qué la semilla no lleva usuarios ni credenciales

`90-semilla-catalogo.sql` carga apps, clientes, vínculos y el inventario de bases de negocio.
Las otras tres cosas van por script, y no es puritanismo:

| Qué | Por qué no va en el `.sql` | Cómo entra |
|---|---|---|
| Primer admin | La clave se hashea con argon2id **en el momento**. Un hash en un `.sql` versionado es una credencial en el repo | `scripts/bootstrap-admin.mjs` |
| Cambio de clave de un usuario | Igual que arriba, y además **no puede ser un `.sql`**: hay que rehashear con argon2id, limpiar el bloqueo y cerrar las sesiones vivas de esa persona, y son cuatro pasos que alguien tiene que hacer igual cada vez | `scripts/resetear-clave.mjs` |
| Credencial de la base de negocio | El `iv(12)‖tag(16)‖ciphertext` se genera con IV **aleatorio por registro**. No se puede escribir en un `.sql`: un IV fijo reutilizado con GCM rompe la confidencialidad por completo | `scripts/registrar-base.mjs` |
| Clave de firma RSA | La master key vive en el entorno, nunca en la base | `scripts/generar-clave.mjs` |

`.gitignore` no protege un archivo ya commiteado. Un `.sql` es exactamente el tipo de archivo
que alguien abre, edita, y commitea.

---

## Olvidé la clave: `npm run resetear:clave`

El admin se queda sin clave, o la bloquea con cinco intentos y no recuerda cuál era. El script
es deliberadamente **mínimo y manual**: pide la clave con eco oculto, valida la misma política
mínima que el alta, limpia el contador de intentos y el bloqueo, y **cierra las sesiones vivas de
ese usuario en todos los clientes** — cambiarle la clave y dejarlo adentro con un refresh de 7
días no habría cambiado nada.

```bash
npm run resetear:clave -- --listar          # ver usuarios, intentos y bloqueos
npm run resetear:clave -- --usuario admin   # cambiar la clave de uno
```

Tres cosas que **no** hace, y por qué:

- **No es un endpoint HTTP.** Quien puede correrlo ya tiene el archivo de la base y la master key:
  ya ganó. Una ruta de recuperación expuesta sin factor de recuperación es peor que no tener
  puerta.
- **No manda correo ni SMS.** No hay nada que auditar como `aud_login` más allá del log del
  proceso, y "olvidé mi clave" por correo es un camino de robo de cuentas esperando su
  implementación. Eso es la Fase 08, con su flujo diseñado.
- **No da ni quita de alta** al usuario. Si la cuenta está dada de baja, el camino es otro.

Un usuario **con historial de auditoría no se puede borrar** desde la app:
`aud_login.idusuario` es `ON DELETE NO ACTION` y es a propósito, porque `aud_login` es append-only
(invariante de `AGENTS.md`: nunca se borra auditoría desde código de negocio). El `DELETE` de un
usuario con logins previos falla con FK.

Los fixtures que crea una corrida de verificación (los `f04.*`, `prueba.*`) caen en eso. Se borran
igual, pero **a mano y en orden inverso al de las FK**: `tok_refresh_token` y
`tok_autorization_code` por `sid`, `tok_sesion`, `idn_usuario_cliente_aplicacion`,
`idn_usuario_cliente`, las filas de `aud_login` de ese usuario, y recién ahí `idn_usuario`. Es la
única operación que la base prohíbe y que hay que hacer a propósito, y solo en `tourniquet_dev`:
en una instalación real, un usuario con auditoría se **deshabilita** (`estado = 'inactivo'`), nunca
se borra.

---

## La semilla es de desarrollo

`90-semilla-catalogo.sql` trae los clientes del despliegue actual (`cervi`, `marcelino`, `jugos`,
`santander`), sus cuatro bases de RHPro y un `redirect_uri` de `localhost`. Los datos están en
tres tablas de entrada (`#apps`, `#clientes`, `#bases`) al principio del archivo: agregar un
cliente es **agregar una fila**, no copiar un bloque de `INSERT`.

`marcelino` es el cliente de desarrollo: su base es donde se trabaja RHPro hoy.

Las bases se registran **sin contraseña** (`credencial_cifrada` NULL) y con `usuario` en el
centinela `sin_registrar`. El centinela es una decisión de esquema, no un atajo: `usuario` es
`NOT NULL` a propósito, para que toda base registrada sea una base que existe. La contrapartida
es que **el código tiene que comparar contra `sin_registrar` antes de armar una conexión**; un
string de conexión armado con ese valor falla con "login failed", que no dice "no lo
registraste". El inventario de la sección 6 de la semilla lo marca como `PENDIENTE`.

**En una instalación de cliente no se usa ese archivo**: se genera uno propio con

```bash
node scripts/generar-instalacion.mjs     # pregunta codigo, dominios, base y tema
```

que escribe un `91-semilla-<cliente>.sql` con los dominios reales.

Un `localhost` que queda en `cat_aplicacion.redirect_uris_json` de una instalación real es un
`redirect_uri` válido **para siempre**: alguien que corra un IdP en su máquina podría canjear
codes (`specs/01` §9). Es la trampa 5 de la Fase 10 y la primera que se revisa en la instalación.

---

## Verificar que los dos caminos coinciden

```bash
# Camino A: base nueva, un solo archivo
sqlcmd -S <srv> -d base_A -i deploy/sql/00-crear-base.sql
sqlcmd -S <srv> -d base_A -i deploy/sql/99-verificar-esquema.sql -W -s "|" -o huella_A.txt

# Camino B: base nueva, incrementales en orden
sqlcmd -S <srv> -d base_B -i deploy/sql/00-crear-base.sql
sqlcmd -S <srv> -d base_B -i deploy/sql/01-<cambio>.sql
# ... y así con todos
sqlcmd -S <srv> -d base_B -i deploy/sql/99-verificar-esquema.sql -W -s "|" -o huella_B.txt

# Comparar (la línea 2 es el nombre de la base: única diferencia admisible)
--        diff <(tail -n +7 huella_A.txt) <(tail -n +7 huella_B.txt)
--   5b. `+7` porque las 6 primeras lineas son encabezado: las 3 primeras cambian
--       en cada corrida (base y timestamp) y no son parte de la huella. Comparar
--       desde la linea 2 daria siempre una diferencia y haria creer que los
--       caminos divergen cuando no divergen.
```

Cero diferencias = la regla se está cumpliendo. Si hay diferencias, el SQL que falta está en
uno de los dos caminos: se corrige **el SQL**, nunca la huella.

## Qué compara la huella

`99-verificar-esquema.sql` imprime, ordenado y estable: columnas con tipo, longitud, nulabilidad,
identity, default y computed; índices con sus columnas, `DESC`, unicidad y condición de filtro;
FKs con su `ON DELETE`/`ON UPDATE`; y constraints `CHECK`.

Lo que detecta en la práctica: una columna agregada al incremental y no al `00`; un `UNIQUE` que
vino sin su índice filtrado; un `ON DELETE CASCADE` colado en un `RESTRICT`; un `CHECK` de enum
presente en un lado y no en el otro.

No compara **datos**: las semillas y los usuarios de dos instalaciones son distintos por
definición (las claves las genera el usuario en cada una). Lo que tiene que ser idéntico es la
estructura.

---

## Quién ejecuta qué

| Contexto | Qué corre | Cómo |
|---|---|---|
| Agente, desarrollo | Cualquier `.sql` **salvo el bloque 0** | `npm run sql:dev deploy/sql/NN-*.sql` → `scripts/ejecutar-sql-dev.mjs`, con guardia a `tourniquet_dev` |
| Usuario, desarrollo | Todo | `sqlcmd` a mano, o el mismo script |
| Usuario, producción | Todo, incluido `00-crear-base.sql` | `sqlcmd` a mano, con el orden de la Fase 10 |

**La guardia es dura y es la regla 3 de `AGENTS.md`**: el runner aborta si la base no es
exactamente `tourniquet_dev`, y verifica con `SELECT DB_NAME()` en la conexión abierta, no sólo
por la URL del `.env`.

El bloque 0 de `00-crear-base.sql` es el `CREATE DATABASE` **y el `USE [tourniquet]` que lo
sigue**. El marcador `-- @fin-bloque-base` está **después** del `USE`, a propósito: el runner
salta todo lo que está por encima del marcador, así que ni crea la base ni cambia de base, y el
esquema se aplica sobre `tourniquet_dev`. Si el `USE` quedara debajo del marcador, el runner
saltaría el `CREATE` y escribiría el esquema en producción — por eso el `USE` va arriba.

`00-crear-base.sql` tampoco abre `tourniquet_dev` en ningún momento: la base de desarrollo la
crea el usuario, a mano, una vez. El runner **nunca** crea bases.

Un intento de correr esto contra `tourniquet` (producción) aborta y no crea nada. Esa prueba en
negativo es criterio de aceptación de la Fase 01, y es la que más importa de esa fase.

---

## Jobs (95-98)

Los jobs de limpieza de `tok_autorization_code` vencido y de retención de `aud_login` van
como SQL en este directorio (`95-`, `96-`, `97-`, `98-`) y los **crea y agenda el usuario** en
SQL Agent. La app no borra auditoría nunca: append-only (`specs/01` §7).

Todavía no existen; llegan con la Fase 09.

---

## Runbooks

`deploy/runbooks/` lleva la documentación de operación que acompaña al SQL:

| Runbook | Contenido | Cuándo |
|---|---|---|
| `instalacion.md` | De cero a login funcionando, con el orden exacto de los `.sql` | Fase 10 |
| `backup-restore.md` | Backup de la base y de la master key **por separado**, y restore probado | Fase 10 |
| `rollback.md` | Cómo deshacer cada paso de la instalación | Fase 10 |
| `rotacion-claves.md` | Procedimiento de rotación de claves de firma | Fase 09 |

El detalle importante de los backups: la base se respalda, la master key **no viaja con ella**
(`TQ_MASTER_KEY` vive en el gestor de secretos del cliente). Si se pierde, no hay restore
posible: hay que regenerar `tok_clave_firma` y volver a cifrar todas las credenciales de bases.
Por eso el runbook dice dónde se guarda la master key y quién la tiene, en lugar de "en un lugar
seguro".
