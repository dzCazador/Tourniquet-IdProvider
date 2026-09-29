# Fase 01 — Scaffold del repo y base de control `cat_*` / `idn_*` / `tok_*` / `aud_*`

**Estado:** ⬜ Pendiente
**Depende de:** [00](fase-00-login-local-rhpro.md) (no bloquea técnicamente, pero sí por D5)
**Repo:** Tourniquet
**Requiere acción del usuario:** **sí** — correr el SQL de `tourniquet_dev` y el de producción
**Riesgo:** bajo (nada existe todavía)
**Reversible:** sí, `DROP` de las tablas `cat_*` / `idn_*` / `tok_*` / `aud_*` en dev; en producción, restore
**Spec normativo:** `specs/02-base-de-datos.md` completo
**Mapa:** `specs/04-fases.md` Fase 01 (primer tercio)

---

## Por qué va primera en Tourniquet

No hay nada: sin `package.json`, sin `backend/`, sin `frontend/`, sin base. Antes de emitir un solo
token hay que poder **crear la base de control desde cero con un script**, porque el criterio de
aceptación de la Fase 01 de `specs/04` exige que la base sea recreable sólo con `deploy/sql/`
(exportar en una instancia, importar en otra). Eso se decide en el DDL, no después.

También es donde se fija el patrón que las 10 fases siguientes copian: `PrismaService` como único
proveedor (nada de clientes duplicados), módulos por dominio, y el nombre de modelo en minúscula
igual que la tabla.

---

## Objetivo

Un repo que compila, con `backend/` NestJS + Prisma (SQL Server), `frontend/` Next exportable, y
la base de control `cat_*` / `idn_*` / `tok_*` / `aud_*` creada y vacía, con su script de ejecución protegido.

---

## Alcance

**Entra:**

- `package.json` raíz con workspaces (`backend`, `frontend`).
- `backend/` NestJS + Prisma (`provider = "sqlserver"`), `main.ts` con helmet, CORS por origen
  exacto, `ValidationPipe` global, y `dist/main.js` como entrypoint.
- `frontend/` Next App Router con `output: "export"` y un único `/` placeholder.
- `deploy/sql/00-crear-base.sql` (**ya escrito**): crea la base si no existe + las 12 tablas
  `cat_*` / `idn_*` / `tok_*` / `aud_*` de `specs/02` §3 + índices §4, con verificación al final. Se actualiza con cada
  cambio de esquema, en el mismo commit que su incremental.
- `scripts/ejecutar-sql-dev.mjs` con la guardia `tourniquet_dev`.
- `.env.example` con placeholders; `.env` real ignorado.
- Lint configurado y verde en ambos proyectos.

**No entra:**

- Ningún endpoint de negocio. Ni login, ni OIDC (van en 02 y 03).
- Semillas de datos (van en 05).
- El tema gótico (el frontend es un placeholder austero; ver P3 en el `README.md`).

---

## Tareas

### 1. Andamiaje del monorepo

Raíz `package.json`:

```json
{
  "name": "tourniquet",
  "private": true,
  "workspaces": ["backend", "frontend"],
  "scripts": {
    "lint": "npm run lint --workspaces",
    "sql:dev": "node scripts/ejecutar-sql-dev.mjs",
    "bootstrap:admin": "node scripts/bootstrap-admin.mjs"
  }
}
```

Dependencias de `backend` (las mínimas, sin adornos): `@nestjs/common|core|platform-express`,
`@prisma/client`, `class-validator`, `class-transformer`, `argon2`, `reflect-metadata`,
`jose` (RS256 y JWKS: `jose` es la librería que no arrastra el stack de `jsonwebtoken` para firma
asimétrica; evita la tentación del HS256).

`fronted` sin librería de auth todavía (la 04 define el helper PKCE; en esta fase, nada).

### 2. `backend/src/prisma/`

- `prisma.service.ts`: `extends PrismaClient`, un solo provider registrado **una vez** en
  `AppModule`. En el plan multibase de RHPro hay un bug de 33 pools; no se repite acá.
- `schema.prisma` con `provider = "sqlserver"`, `models` en minúscula (`model idn_usuario`),
  mappeando cada tabla de `specs/02` §3 con su `@@map`. Sin `@db.` innecesario: los tipos
  exactos están en el SQL, Prisma sólo los usa para leer y escribir.

**Prisma no genera el DDL.** `schema.prisma` es el mapa de lectura/escritura; el DDL real es
`deploy/sql/`. Nunca `prisma migrate`, `db push` ni `migrate reset` (`AGENTS.md` regla 3).

### 3 · `deploy/sql/00-crear-base.sql`

**El archivo ya está escrito**: `deploy/sql/00-crear-base.sql`. Esta tarea es **revisarlo y
ajustarlo**, no redactarlo desde cero. Contiene las 12 tablas de `specs/02` §3 y los índices de
§4, incluidos los **filtrados** de SQL Server:

- `idn_usuario(usuario)` único
- `idn_usuario(email)` único `WHERE email IS NOT NULL`
- `tok_sesion(idusuario, idaplicacion, creado_en)` filtrado a `cerrada_en IS NULL`
- `tok_sesion(idcliente, creado_en)` filtrado a `cerrada_en IS NULL`
- `tok_refresh_token(expira_en)` filtrado a `revocado_en IS NULL`
- `cat_base_datos(idcliente,idaplicacion)` único `WHERE estado='activo'`

Son 5 índices filtrados; el `SELECT` de verificación del propio archivo lo exige.

Estructura del archivo: bloque 0 (`CREATE DATABASE`, marcado con `-- @fin-bloque-base` para que
el runner de dev lo salte), bloque 1 (convenciones comentadas), bloque 2 (las 12 tablas, en
orden de dependencias de FK), bloque 3 (índices) y bloque 4 (verificación: 12/12 tablas,
5/5 índices filtrados y 0 columnas de material cifrado guardadas como texto).

Qué hay que revisar al tomarlo:

| Punto | Qué mirar |
|---|---|
| Timestamps | `datetime2(3)` UTC, default `sysutcdatetime()`; `actualizado_en` sólo en mutables, nunca en `aud_login`/`tok_sesion`/`tok_refresh_token` |
| UUID | `uniqueidentifier`, lo genera la app con `crypto.randomUUID()`; el SQL no depende de `newid()` |
| Cifrado | `varbinary(512)` con `iv(12)‖tag(16)‖ciphertext` en `credencial_cifrada` y `mfa_secret_cifrada` |
| JSON | `nvarchar(max)` para `*_json` y `clave_publica` |
| Nombres | Sin `ñ` ni acentos en columnas; el español se conserva en los datos |
| FKs | `REFERENCES` reales con `ON DELETE` y `ON UPDATE` explícitos: `NO ACTION` en las dos por default, `CASCADE` sólo en las 4 dependencias fuertes de `00-crear-base.sql`. **Nunca `RESTRICT`**: no existe en T-SQL (Msg 156) |
| Idempotencia | Cada `CREATE TABLE`/`CREATE INDEX` guardado con `IF OBJECT_ID IS NULL` / `IF NOT EXISTS`, para que el archivo se pueda re-correr |
| `tok_sesion.idaplicacion` | Ya está en el `00`. Es la columna que pidió la Fase 03; `NULL` = sesión del portal |
| Recuento | **12 tablas**, no 13 (ver Trampa 1) |

### 4. `scripts/ejecutar-sql-dev.mjs`

Réplica exacta de la guardia de RHPro:

1. Lee `DATABASE_URL` del `.env`.
2. Aborta si la URL no contiene `database=tourniquet_dev` (o elInitial Catalog equivalente).
3. Abre la conexión y corre `SELECT DB_NAME()`: aborta si no es exactamente `tourniquet_dev`.
4. Sólo entonces aplica el `.sql` lote por lote, Partiendo por `GO`.
5. Al final imprime el `SELECT` de verificación que trae el propio script.

El archivo es **transparente**: si la guardia falla, dice por qué y con qué base se connectó
(sólo el nombre, nunca la cadena completa). La cadena de conexión es una credencial: no se loguea
ni siquiera parcialmente (`AGENTS.md`, invariantes de seguridad).

### 5. `frontend/`

Next App Router mínimo, `output: "export"`, un `app/page.tsx` que dice que el portal todavía no
existe. `trailingSlash` y `images.unoptimized` si hacen falta para el export. **Sin** `api/` de
Next: el portal habla con `tq-api` por URL absoluta (el front es estático, no hay runtime Node).

### 6. `.env.example`

```
NODE_ENV=development
PORT=3001
DATABASE_URL=sqlserver://USUARIO_SIN_CLAVE@localhost:1433;database=tourniquet_dev;encrypt=true
TQ_ISSUER=http://localhost:3001
TQ_MASTER_KEY=BASE64_DE_32_BYTES_DE_EJEMPLO_NO_USAR
ACCESS_TTL_MIN=15
```

Placeholder explícito de la master key, no un valor que parezca utilizable.

---

## Criterios de aceptación

- [ ] `npm install` en la raíz instala los dos workspaces sin warnings de peer deps.
- [ ] `cd backend && npm run build` produce `dist/main.js` y `npm run start` levanta.
- [ ] `cd backend && npm run lint` verde. Ídem `frontend`.
- [ ] `cd frontend && npm run build` genera el export estático sin error.
- [ ] `npm run sql:dev deploy/sql/00-crear-base.sql` crea las 12 tablas y sus índices en
      `tourniquet_dev`.
- [ ] El `SELECT` de verificación del propio `.sql` lista las 12 tablas y dice `OK` en cada una.
- [ ] **Guardia probada en negativo**: apuntar el `.env` a `tourniquet` (producción) y correr el
      script ⇒ aborta con mensaje claro y **no** crea nada. Es la prueba que más importa de esta
      fase.
- [ ] `prisma migrate` / `db push` **no** se ejecutó nunca; el esquema viene sólo del `.sql`.
- [ ] La base es **recreable de cero**: `DROP` de las tablas, volver a correr el script, y el
      `SELECT` de verificación da el mismo resultado.
- [ ] Camino B equivalente: `DROP`, correr el `00` y luego cualquier incremental que exista, y
      `99-verificar-esquema.sql` da **cero diferencias** contra el camino A (ver `deploy/README.md`).
- [ ] Cero secretos en el repo: `git status` limpio de `.env`, `git grep -i "password="` sólo
      pega en `.env.example`.
- [ ] `README.md` actualizado con las instrucciones de arranque (4 comandos, en orden).

---

## SQL que ejecuta el usuario

| Cuándo | Qué | Dónde |
|---|---|---|
| Al verificar la fase | `00-crear-base.sql` (bloque 2 en adelante) | `tourniquet_dev` (el agente, con permiso explícito — P2) |
| Al desplegar en un cliente | el mismo archivo, **bloque 0 incluido** (el usuario crea la base) | base `tourniquet` de producción |

**Ninguna otra.** Si la fase necesita un segundo `.sql` (por ejemplo un `02-indices.sql` para no
depender del orden de la 01), se numera aparte y se documenta acá. El criterio es que la base se
construya aplicando `01..NN` en orden, y sólo eso.

---

## Seguridad

- La master key **no** existe todavía en ningún lado: la crea el usuario en la Fase 02 con
  `scripts/generar-clave.mjs`. Nunca en el repo, nunca en un `.sql`, nunca en un backup suelto.
- `.env` y `.env.*` ya están en `.gitignore` con la excepción `!.env.example`. No tocar esa regla.
- El usuario SQL de la app: **un solo login** con permisos mínimos sobre `cat_*` / `idn_*` / `tok_*` / `aud_*` (SELECT/INSERT/
  UPDATE, sin ALTER ni DROP en producción). Crear el login de aplicación es una tarea del runbook de
  despliegue (Fase 10), no de esta fase.

## Trampas

1. **Son 12 tablas, no 13.** El conteo de `specs/02` §3 da 12: `cat_cliente`,
   `cat_aplicacion`, `cat_cliente_aplicacion`, `cat_base_datos`, `idn_usuario`, `idn_usuario_cliente`,
   `idn_usuario_cliente_aplicacion`, `tok_sesion`, `tok_autorization_code`, `tok_refresh_token`,
   `tok_clave_firma`, `aud_login`. Contar de nuevo antes de escribir el `SELECT` de
   verificación, porque un número equivocado en el criterio de aceptación hace perder tiempo
   después.
2. **`cat_aplicacion.codigo` es la PK y también el `aud`.** Si alguien la modela con `id` numérico
   después, hay que corregir claims y URLs en toda la fase 03. Decidirlo ahora.
3. **`tok_autorization_code.code_hash` es `nvarchar(128)` pero el contenido es sha256 hex (64).**
   Sobra espacio, está bien; lo que no puede cambiar después es el ancho, porque el índice único
   depende de él.
4. **El `IF NOT EXISTS` en SQL Server**: `CREATE TABLE IF NOT EXISTS` no existe antes de 2016 y no
   es transaccional. El script de la 01 asume base vacía; los scripts **incrementales** (02 en
   adelante) llevan su propio chequeo de existencia. Documentar esa diferencia.
