# 02 — Base de control: tablas, tipos y reglas SQL

## 1. Topología y motor

- **Una sola base de control**: `tourniquet` (producción), **`tourniquet_dev`** (desarrollo).
  Apuntan `DATABASE_URL` (dev) y la variable del despliegue (producción, la corre el usuario).
- **Motor único: SQL Server.** `schema.prisma` con `provider = "sqlserver"`; **no existe**
  variante de schema ni artefactos `.mysql.sql` por deploy (a diferencia de RHPro). Se mantiene
  la *disciplina* de SQL portable (nada de funciones T-SQL exóticas) para no hipotecar el futuro,
  pero el único entregable ejecutable es SQL Server.
- Prisma es el único acceso a datos de `tq-api`; el DDL lo maneja SQL versionado (D3 de
  `AGENTS.md`): prohibido `prisma migrate`, `db push`, `migrate reset`.
- Modelo de Prisma en minúscula igual que la tabla (`model idn_usuario`), convención heredada de
  RHPro.

## 2. Convenciones de esquema

| Regla | Detalle |
|---|---|
| Prefijo | **Prefijo de función**, uno de cuatro: `cat_`, `idn_`, `tok_`, `aud_` (§2.1) |
| PK | `id` o `id<entidad>`; naturales de negocio cuando son estables y cortos (`codigo`) |
| FKs | **Reales** (`REFERENCES`) con `ON DELETE` y `ON UPDATE` explícitos: `NO ACTION` por default, `CASCADE` sólo en dependencias fuertes (ver `deploy/sql/00-crear-base.sql`) |
| UUID | `uniqueidentifier`; lo genera la app (`crypto.randomUUID()`), el SQL no depende de `newid()` |
| Timestamps | `datetime2(3)`, **UTC siempre**, default `sysutcdatetime()`; columnas `creado_en`, y `actualizado_en` sólo en entidades mutables (nunca en audit/sesion/refresh) |
| TEXT | `nvarchar(max)` para JSON (`*_json`) y clave pública; `nvarchar(n)` acotado para el resto |
| Binario cifrado | `varbinary(512)` como `iv(12)‖tag(16)‖ciphertext` (AES-256-GCM, ver `specs/01` §6). **Excepción:** `tok_clave_firma.clave_privada_cifrada` es `varbinary(max)` porque el PEM PKCS#8 de una RSA 2048 ronda los 1700 B y no entra en 512 |
| Colores/abreviaturas | Sin `ñ` ni acentos en **nombres** de columna; el español se conserva (ver `orígenes` → `origenes`) |

### 2.1 Prefijos de función (normativo)

Cada tabla se nombra `<función>_<entidad>`. Hay **cuatro** prefijos y ninguno más:

| Prefijo | Función | Tablas |
|---|---|---|
| `cat_` | **Catálogo y tenancy**: qué clientes existen, qué apps hay, y el inventario de sus bases de negocio | `cat_cliente`, `cat_aplicacion`, `cat_cliente_aplicacion`, `cat_base_datos` |
| `idn_` | **Identidad**: personas y sus permisos por tenant y por app | `idn_usuario`, `idn_usuario_cliente`, `idn_usuario_cliente_aplicacion` |
| `tok_` | **Sesión y tokens**: el estado de un login en curso, y el material de OIDC | `tok_sesion`, `tok_autorization_code`, `tok_refresh_token`, `tok_clave_firma` |
| `aud_` | **Auditoría** | `aud_login` |

**Por qué función y no producto.** La base de control es una base propia y exclusiva de
Tourniquet (D3 de `specs/00`): no hay objetos ajenos con los que colisionar, así que el prefijo
no tiene que reservar espacio en un namespace compartido. En ese lugar, agrupar por función
paga: cuando se lee `deploy/sql/00-crear-base.sql` de arriba abajo, los bloques ya viene
agrupados, y `grep '^CREATE TABLE' ` dice de un vistazo qué toca revisar cuando se cambia el
login o la rotación de tokens.

**Por qué igual se conserva un prefijo.** Sin él no se puede responder "¿cuáles tablas son
nuestras?" con un `LIKE`, ni grep-ear el proyecto, ni escribir la verificación de `00-crear-base.sql`
sin enumerar los cuatro. Con los cuatro prefijos, esa pregunta es
`name LIKE 'cat[_]%' OR name LIKE 'idn[_]%' OR name LIKE 'tok[_]%' OR name LIKE 'aud[_]%'`.

**Los nombres derivados heredan el prefijo de su tabla.** Un índice o constraint se llama
`<TIPO>_<tabla>_<resto>` con el prefijo de la tabla, no el de otra: `IX_tok_sesion_expira` es de
`tok_sesion`. Cuando la tabla se renombra, se renombran sus 5 objetos derivados; el nombre viejo
deja de ser válido y no se reutiliza.

**Abreviaturas que ya existían y siguen válidas** (sólo en nombres de objetos, nunca en el de la
tabla): `uca` = `usuario_cliente_aplicacion`, `authcode` = `autorization_code`,
`refresh` = `refresh_token`.

**Límite de longitud.** Los nombres de índice y constraint se acotan a 128 caracteres en SQL
Server. `UQ_idn_usuario_cliente_aplicacion_cliente_rol` entra justo; si alguna vez un nombre
derivado se pasa, se abrevia el *resto*, nunca el prefijo de función.

## 3. Tablas

### Registro de plataforma

| Tabla | Columnas principales | Notas |
|---|---|---|
| `cat_cliente` | `codigo` (PK, nvarchar(20)), `nombre` nvarchar(100), `estado` (`activo\|inactivo`), `politica_json` null | Inquilino. Chile/AR del mismo cliente = **un tenant, varias bases/apps** |
| `cat_aplicacion` | `codigo` (PK: `rhpro`, `rhpro-chile`, futuras), `nombre`, `tipo_cliente` (`public` hoy), `redirect_uris_json`, `origenes_json`, `estado` | Catálogo global; `aud` del token = `codigo` |
| `cat_cliente_aplicacion` | (`idcliente`,`idaplicacion`) PK compuesto | Qué apps existen *para este cliente* |
| `cat_base_datos` | `codigo` (PK nvarchar(40)), `idcliente`, `idaplicacion`, `host`, `base` nvarchar(100), `esquema` null, `usuario`, `credencial_cifrada` varbinary(512), `engine` default `'sqlserver'`, `connection_limit` int null, `estado`, `notas` | **Inventario** (D3 de `specs/00`): Tourniquet no se conecta. `rhpro_cervi`, `rhpro_marcelino`, la base de Chile, etc. se registran acá |

### Identidad

| Tabla | Columnas principales | Notas |
|---|---|---|
| `idn_usuario` | `idusuario` uniqueidentifier PK, `usuario` nvarchar(50) **unique** (minúscula), `nombre`, `apellido`, `email` null, `clave_hash` nvarchar(255) argon2id, `mfa_secret_cifrada` null, `mfa_estado` (`off\|pending\|on`), `estado` (`activo\|bloqueado\|inactivo`), `intentos_fallidos` int, `bloqueado_hasta` datetime2 null, `creado_en`, `actualizado_en` | Identidad global. El mapeo a `user_per.iduser` de cada base vive en la app (Fase 02, `specs/03`); **no** se copia aquí |
| `idn_usuario_cliente` | (`idusuario`,`idcliente`), `rol` (`user\|admin_identidad`), `creado_en` | Membresía al tenant. `admin_identidad` puede habilitar accesos de ese cliente (Fase 03); no es permiso de negocio |
| `idn_usuario_cliente_aplicacion` | (`idusuario`,`idcliente`,`idaplicacion`), `creado_en` | Habilitación de ingreso por app. **Sólo** controla *entrar o no*, nunca qué ve dentro |

### Sesiones y tokens

| Tabla | Columnas principales | Notas |
|---|---|---|
| `tok_sesion` | `sid` uniqueidentifier PK, `idusuario`, `idcliente`, `idaplicacion` **NULL = sesión del portal**, `amr` nvarchar(50), `ip`, `user_agent` nvarchar(500), `creado_en`, `expira_en` (absoluta +30 d), `cerrada_en` null, `motivo_cierre` (`logout\|revocada\|replay\|expirada`) null | **Una fila por app**, no una por usuario: el mismo usuario entrando en dos apps tiene dos `sid`, y el `sid` del token es el de la app (`specs/01` §2.1). La fila del portal (`idaplicacion IS NULL`) es la que vive en la cookie y de la que se deduce el `tenant`; nunca es el `sid` de un token de app. La vida del refresh deslizante **nunca** extiende `expira_en` |
| `tok_autorization_code` | `id` bigint IDENTITY PK, `sid` (sesión **de la app**), `idaplicacion`, `code_hash` nvarchar(128) unique (sha256), `code_challenge` nvarchar(128), `method` ('S256'), `redirect_uri`, `state_hash` null, `creado_en`, `expira_en` (+60 s), `usado_en` null | PKCE; persistido porque el authorize y el token pueden caer en instancias distintas. `code_hash` y `state_hash` son sha256: **ni el code ni el `state` en claro**, ni en la base ni en un log |
| `tok_refresh_token` | `id` bigint IDENTITY PK, `sid`, `idaplicacion`, `token_hash` nvarchar(64) unique (sha256), `creado_en`, `expira_en`, `usado_en` null, `reemplazado_por` null, `revocado_en` null, `motivo` null | Rotación estricta: `usado_en` + reuso ⇒ revocar la familia del `sid` |

### Infraestructura de seguridad

| Tabla | Columnas principales | Notas |
|---|---|---|
| `tok_clave_firma` | `kid` nvarchar(32) PK, `alg` ('RS256'), `clave_publica` nvarchar(max), `clave_privada_cifrada` varbinary(max), `activa` bit, `creado_en`, `retirada_en` null | JWKS sirve `activa` + las retiradas dentro de 24 h. La master key `TQ_MASTER_KEY` no vive en la base |
| `aud_login` | `id` bigint IDENTITY PK, `ts`, `idusuario` null (login inexistente ⇒ null), `idaplicacion` null, `ip`, `user_agent`, `resultado` (`ok\|claves\|bloq\|replay\|expirado\|error`), `detalle` nvarchar(500) null | **Append-only**: sin UPDATE/DELETE desde la app; retención 2 años por job externo |

## 4. Índices mínimos

- `idn_usuario(usuario)` único; `(email)` único filtrado `WHERE email IS NOT NULL`.
- `tok_sesion(idusuario, cerrado NULL)` para listar sesiones activas del portal.
- `tok_refresh_token(sid, idaplicacion)` y `(token_hash)` único.
- `tok_autorization_code(expira_en)` (job de limpieza de códigos vencidos, 5 min).
- `aud_login(ts)` y `(idusuario, ts)`; el job de retención borra por rango de `ts` afuera
  de la app.
- `cat_base_datos(idcliente,idaplicacion)` único filtrado `WHERE estado='activo'` (una base
  activa por combinación).

## 5. DDL y procedimiento (hereda la política de RHPro)

- Scripts en `deploy/sql/NN-titulo.sql`, numerados, con comentarios de propósito, lotes
  separados por `GO` y `SELECT` de verificación al final — mismo formato que
  `RHPro-NextGeneration/specs/cambios-de-base.md`, **sin** generar el par `.mysql.sql`.
- Ejecución del agente: `scripts/ejecutar-sql-dev.mjs` réplica exacta de la guardia de RHPro
  (pre-check de la URL + `DB_NAME()`), con whitelist **`tourniquet_dev`** y nada más. El SQL de
  producción lo corre el usuario.
- Semillas: `deploy/sql/90-semilla-*.sql` sólo con catálogo no sensible (clientes, apps); el
  primer usuario administrador se crea con `scripts/bootstrap-admin.mjs` (lee password de
  prompt, hash argon2id, nunca por SQL en texto).

### 5.1 Los dos caminos del esquema (normativo)

El esquema se construye de dos maneras, y **deben dar el mismo resultado**:

| Camino | Para qué | Archivos |
|---|---|---|
| **(A) Creación desde cero** | Instalación de un cliente, base nueva, máquina nueva, base reconstruida | `deploy/sql/00-crear-base.sql`, uno solo y siempre completo |
| **(B) Evolución incremental** | Base ya instalada que va tomando cambios de a uno | `00-crear-base.sql` + `01-*.sql` + `02-*.sql` + … en orden |

**Regla dura: todo cambio de esquema se entrega en dos archivos y en el mismo commit** — el
incremental `NN-<cambio>.sql` para las bases existentes, **y** la actualización de
`00-crear-base.sql` para las nuevas. Si divergen, es un defecto. No se corrige la divergencia a
mano: se corrige el SQL que falta.

`deploy/sql/99-verificar-esquema.sql` imprime la huella del esquema (columnas, índices, FKs,
`CHECK`) para comparar (A) contra (B): **cero diferencias** es el criterio de aceptación de
cualquier fase que cambie el esquema. Detalle del procedimiento en `deploy/README.md`.

Numeración: `00-` creación desde cero · `01-`–`89-` incrementales (un cambio por archivo) ·
`90-`–`94-` semillas · `95-`–`98-` jobs de limpieza y retención · `99-` verificación. **Un
número retirado no se reutiliza**: una base que aplicó el `07` no puede recibir después un `07`
distinto.

`deploy/sql/_plantilla-incremental.sql` documenta cómo se escribe un incremental (idempotencia,
lotes por `GO`, qué no va en un `.sql`). No se ejecuta.

**Lo que nunca va en un `.sql`**, por ser credenciales con cifrado no determinista o por ser
secretos: usuarios y hashes (van por `scripts/bootstrap-admin.mjs`, argon2id en el momento),
`credencial_cifrada` de bases de negocio (IV aleatorio por registro, `scripts/registrar-base.mjs`),
claves de firma y master key. `.gitignore` no protege un archivo ya commiteado.

La semilla de `90-` es de **desarrollo** (cliente de ejemplo + `redirect_uri` de `localhost`). En
una instalación de cliente se genera una propia con `scripts/generar-instalacion.mjs`: un
`localhost` en `cat_aplicacion.redirect_uris_json` de una instalación real es un `redirect_uri`
válido para siempre (`specs/01` §9).
