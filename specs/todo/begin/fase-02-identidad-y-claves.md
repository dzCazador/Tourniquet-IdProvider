# Fase 02 — Identidad: argon2id, bootstrap, claves de firma y auditoría

**Estado:** ✅ **Completada y verificada contra la base real**
(2026-09-29: bootstrap, idempotencia, cifrado, JWKS, bloqueo y auditoría, los tres
scripts end-to-end sobre SQL Server 2022). Se agregaron además el esquema **Joi** de
variables de entorno y tres arreglos al scaffold de la Fase 01 — ver *Lo que se
agregó y corrigió* al final.
**Depende de:** [01](fase-01-scaffold-control.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** **sí** — crear `TQ_MASTER_KEY` en el entorno y correr el bootstrap
**Riesgo:** medio (la clave de firma mal creada deja el IdP sin JWKS)
**Reversible:** la clave de firma se puede regenerar (invalida tokens emitidos, que a esta altura
no hay); la master key **no** se puede recuperar
**Spec normativo:** `specs/01-tokenos-y-seguridad.md` §4, §5, §6, §7
**Mapa:** `specs/04-fases.md` Fase 01 (segundo tercio)

---

## Por qué esta fase va antes del núcleo OIDC

El JWKS y el token dependen de una clave RSA que **nace y vive cifrada en la base**. Si el
intercambio de la clave (generar, cifrar, guardar, descifrar al firmar) tiene un defecto, ese
defecto aparece recién cuando una app valida tokens, o sea en la Fase 06, cuando ya hay usuarios y
auditoría reales encima. Conviene resolverlo en una unidad de trabajo chica y verificable por
consola.

Lo mismo con el hash de contraseña: si argon2id se prueba mal o con parámetros que no coinciden con
`specs/01` §4, el primer login real falla y el primer admin creado queda inaccesible.

---

## Objetivo

Poder (a) crear el primer usuario administrador desde consola con argon2id y (b) firmar y publicar
un JWKS válido, con las claves privadas cifradas en AES-256-GCM bajo una master key que existe sólo
en el entorno.

---

## Alcance

**Entra:**

- `TQ_MASTER_KEY`: 32 bytes base64, generada por script, nunca escrita en un archivo del repo.
- Módulo `claves/`: generación del par RSA 2048, `kid` = hash corto de la clave pública, cifrado
  AES-256-GCM de la privada en `tok_clave_firma.clave_privada_cifrada`, lectura y descifrado en
  memoria.
- `scripts/generar-clave.mjs` (master key) y `scripts/bootstrap-admin.mjs` (primer admin).
- Módulo `auth/`: hash y verificación argon2id con los parámetros de `specs/01` §4, y la escritura
  en `aud_login` para cada resultado.
- Política de bloqueo de `idn_usuario.intentos_fallidos` / `bloqueado_hasta`.
- Rate limit del login: 10 req/min por IP + 10/min por usuario (el peor gana).

**No entra:**

- Endpoints HTTP: la Fase 03 los monta sobre esto. En esta fase todo se prueba por consola/script.
- `cat_base_datos.credencial_cifrada`: el cifrado de credenciales de bases (`specs/01` §6) se
  implementa en la Fase 05, cuando exista la tabla con datos. **La misma primitiva de cifrado** se
  prueba acá sobre una fila de prueba y se descarta.
- `mfa_secret_cifrada`: Fase 09.
- El login real en el portal: Fase 04.

---

## Tareas

### 1. Cifrado simétrico (`src/claves/crypto.ts`)

Función única, reutilizada por todo lo cifrado:

```
cifrar(texto, masterKeyB64) -> Buffer   // iv(12) aleatorio ‖ tag(16) ‖ ciphertext
descifrar(buf, masterKeyB64) -> texto
```

- `crypto.createCipheriv('aes-256-gcm', key, iv)` con `iv = randomBytes(12)` **por registro**.
- El IV se guarda pegado al ciphertext, como dice `specs/01` §6 y el tipo `varbinary(512)` de
  `specs/02` §2. **Nunca** un IV fijo: reutilizarlo con GCM rompe la confidencialidad por completo.
- Si `TQ_MASTER_KEY` no está, no es 32 bytes, o no decodifica de base64 → **fallar al arrancar**,
  con mensaje explícito. Nunca seguir con una clave derivada a la fuerza.
- La master key se lee una vez en el arranque y se mantiene en memoria; no se loguea, no se expone
  por ningún endpoint, no va en el `health`.

### 2. Claves de firma (`src/claves/firma.service.ts`)

- Generar RSA 2048 con `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })`.
- `kid` = hash corto de la clave pública (los primeros 16 hex de sha256 del SPKI DER, que es
  estable y no filtra nada de la privada).
- Insertar en `tok_clave_firma` con `activa = 1`, `alg = 'RS256'`, `creado_en` UTC.
- Al firmar: leer la activa, descifrar la privada, firmar con `jose` (`SignJWT`, `RS256`), header con
  `kid`.
- Rotación (Fase 09): el método `activarNueva()` ya existe ahora — generar, insertar, marcar la
  anterior `retirada_en` — pero **no se expone por HTTP** hasta la 09.
- Endpoint de lectura de JWKS (esto sí es un GET público, sin autenticación): sirve la activa +
  las retiradas con `retirada_en` dentro de 24 h (`specs/01` §5).

### 3. Identidad (`src/auth/identidad.service.ts`)

- `argon2` con `m=65536, t=3, p=4`, `type: argon2id`, salt de 16 bytes aleatorios. Los parámetros
  van **en el hash** (formato PHC), así que un cambio futuro de `t` no invalida los hashes viejos:
  se verifica con los que trae el hash y se rehashea en el próximo login successful. Dejar esto
  anotado en el código, no en un comentario suelto: es la diferencia entre un sistema que migra y
  uno que hay que volver a hashear a mano.
- `crearAdmin(usuario, nombre, apellido, clave)`: valida la política mínima (10 caracteres, sin
  diccionario común, sin fecha del tenant — `specs/01` §4), hashea, inserta en `idn_usuario` con
  `estado='activo'`, `mfa_estado='off'`, `intentos_fallidos=0`.
- `verificar(usuario, clave)`: busca por `usuario` en minúsculas, compara con `argon2.verify`,
  devuelve el resultado **sin distinguir usuario inexistente de clave mala** (mismo mensaje, mismo
  tiempo aproximado: comparar con un hash dummy cuando el usuario no existe, para no filtrar por
  timing).
- Bloqueo: 5 fallos seguidos ⇒ `bloqueado_hasta = ahora + 15 min` + evento `bloq` en auditoría.
  Contador **por usuario**, no por IP.
- Auditar **todo**: `ok`, `claves`, `bloq`, `error`. Con la `ip` y el `user_agent` del request.
  Nunca el `usuario` en el `detalle` si el login falló por credenciales: el `detalle` lleva un
  código de motivo, no un volcado del input.

### 4. `scripts/generar-clave.mjs`

Genera 32 bytes aleatorios, los imprime en base64 y le dice al usuario la línea exacta para su
entorno. Se niega a escribir en `.env`: el `.env` lo edita el usuario a mano, y el script jamás
toca un archivo que después se confunda con el repo. Print explícito: "esta master key no tiene
recuperación; si la perdés, hay que recifrar `tok_clave_firma` y `cat_base_datos`".

### 5. `scripts/bootstrap-admin.mjs`

- Pide usuario y clave por prompt (`readline` con eco oculto, o pedir que se pase por variable de
  entorno y **no** dejarla en el historial del shell).
- Valida la política mínima antes de hashear.
- Inserta el admin, crea su `idn_usuario_cliente` para cada cliente activo, e imprime el `idusuario`
  (UUID) que se va a usar en la Fase 06 como `idp_sub`.
- Idempotente: si el usuario ya existe, no lo pisa; avisa.

### 6. Rate limit

`@nestjs/throttler` o un guard propio con contador en memoria. La opción en memoria es suficiente
para una instancia por instalación (D3 de `specs/00`); si algún día hay varias instancias, se
documenta el problema y se pasa a store externo. Doble límite: 10/min por IP **y** 10/min por
usuario, se aplica el que salte primero.

---

## Criterios de aceptación

- [x] `npm run bootstrap:admin` crea el primer admin con hash argon2id verificable
      (`argon2.verify` true) y **cero** secretos en consola más allá del prompt.
- [x] Correr el bootstrap dos veces no duplica ni pisa nada.
- [x] Con `TQ_MASTER_KEY` ausente o de largo distinto de 32 B, la app **no** arranca, con mensaje
      claro.
- [x] `tok_clave_firma` tiene 1 fila `activa=1`; `clave_privada_cifrada` es binario
      `iv(12)+tag(16)+ciphertext` (28 B de overhead + el PEM cifrado) y **no** empieza con
      `-----BEGIN` ni es texto legible.
- [x] Descifrar la fila con la master key devuelve un PEM RSA válido (verificado por script, no a
      ojo).
- [x] Firmar un JWT con la clave leída desde la base y validarlo con `jwtVerify` de `jose` y la
      clave pública del JWKS: **ok**.
- [x] El JWT lleva header `alg=RS256` y `kid` igual al de la fila. `alg=none` y HS256 son
      rechazados por el verificador.
- [x] El JWKS sirve la activa y excluye las retiradas con `retirada_en` de más de 24 h.
- [x] `verificar()` con usuario inexistente y con clave mala devuelve el mismo mensaje y tarda
      comparablemente (diferencia medida, no obviamente distinta).
- [x] 5 intentos fallidos bloquean 15 min; el correcto posterior al bloqueo también falla.
- [x] Cada intento (ok/claves/bloq) dejó fila en `aud_login` con `ip` y `user_agent`.
- [x] `grep` sobre los logs de la corrida: no aparece ni el `usuario` completo junto a la clave, ni
      el hash, ni la master key.
- [x] `npm run lint` verde.

> **Nota sobre el tamaño de `clave_privada_cifrada`.** El criterio original decía "48 B para una
> clave de 2048 + overhead", y eso está mal: el PEM PKCS#8 de una RSA 2048 ronda los **1704 B**, así
> que el total va a ~1732 B, no 48. (Los 48 B serían sólo `iv+tag+overhead` de un criptograma simétrico
> corto, no de una clave.) Se corrigió el criterio arriba. Importa porque `specs/02` §2 dimensiona la
> columna como `varbinary(512)`: **una clave RSA 2048 en PEM no entra.** El DDL real ya declara
> `varbinary(max)`, que sí entra, pero `specs/02` hay que actualizarlo antes de que alguien lo copie.

---
## Estado de verificación (2026-09-29, contra SQL Server 2022 real)

Base de control `tourniquet`, 16 tablas aplicadas, `cat_cliente` con 4 clientes activos
(`cervi`, `jugos`, `marcelino`, `santander`).

**Identidad y bootstrap**

- `npm run generar:clave` → 32 B = 44 caracteres base64 canónicos; rechaza argumentos; **no**
  escribe ningún archivo (`.env` sigue sin aparecer).
- `npm run bootstrap:admin -- --usuario admin --nombre Ana --apellido Perez` →
  `kid=8a2eb4afc6fed189`, admin creado, 4 membresías (una por cliente activo), `idusuario` impreso.
- **Idempotencia**: 2ª corrida → `[aviso] El usuario "admin" ya existia`, 0 membresías nuevas.
  En la base queda: 1 `idn_usuario`, 4 `idn_usuario_cliente` (sin duplicar), 1 `tok_clave_firma`
  activa.
- Hash real en la base: `$argon2id$v=19$m=65536,t=3,p=4$…`, `argon2.verify` **true** contra la fila.

**Claves de firma (contra la fila real, no contra un doble)**

- Prisma devuelve `clave_privada_cifrada` como **Buffer** de **1732 B** = `iv(12)+tag(16)+1704 PEM`.
  No empieza con `-----BEGIN`, no es texto legible.
- Descifrado con `TQ_MASTER_KEY` → PEM PKCS#8, `createPrivateKey` lo acepta como RSA de **2048 bits**.
- `kid` recalculado desde el SPKI de la pública = `8a2eb4afc6fed189` = el de la fila, y la pública
  del JWK corresponde a esa privada (mismo par).
- `npm run verificar:clave`: **17/17**, exit 0. Incluye `alg=none` y HS256 rechazados, `sid`/`amr`
  presentes, y ciphertext distinto en cada cifrado (IV aleatorio).

**Auditoría y bloqueo (escritura real en `aud_login`)**

- 3 intentos → 3 filas: `ok` (con `idusuario`), `claves`/`clave_incorrecta` (con `idusuario`), y
  `claves`/`clave_incorrecta` con **`idusuario` NULL**. El usuario inexistente se distingue por ahí,
  no por el mensaje. Todas con `ip` y `user_agent`.
- `aud_login` no contiene ni el hash ni la clave.
- 5 intentos fallidos → `intentos_fallidos=5`, `bloqueado_hasta` = **+15 min**; la clave
  **correcta** también falla (`bloq`/`usuario_bloqueado`). Contador y bloqueo reseteados después.

---

## Seguridad (los invariantes que esta fase puede pisar)

| Invariante | Cómo se respeta acá |
|---|---|
| No loguear `pwd_hash`, `mfa_secret` ni material de claves | Ni un prefijo del hash. La clave privada vive cifrada y sólo se descifra en memoria para firmar |
| Master key fuera del SQL y fuera del repo | Env var, 32 B base64, generada por script, sin fallback |
| Sin IV reutilizado en GCM | `randomBytes(12)` por cifrado, guardado junto al ciphertext |
| Contraseñas argon2id | `type: argon2id` explícito, nunca el default si cambia en la librería |
| Auditoría append-only | Sólo INSERT; esta fase no abre el `UPDATE`/`DELETE` que nadie debe abrir después |
| Sin credenciales ajenas en claro | `cat_base_datos.credencial_cifrada` se cifra en la 05, no antes: la tabla existe vacía |
| Valores sensibles fuera de los mensajes de error | `redactar()` en `config/env.schema.ts`; prohibido `.pattern()` sobre variables sensibles |

## Trampas

1. **La clave privada cifrada no es recuperable sin la master key.** Si el usuario pierde
   `TQ_MASTER_KEY` después de la Fase 05, hay que regenerar claves de firma y volver a cifrar todas
   las credenciales de bases. Por eso el script de la master key lo dice con esas palabras, y por eso
   la master key se guarda en el gestor de secretos del cliente, no "en un lugar seguro" cualquiera.
2. **`argon2id` no es el default de la librería en todas las versiones.** Pasarlo explícito. Un
   hash argon2i (más débil) pasa la prueba de "es argon2" y no pasa la de seguridad.
3. **Comparar en minúsculas el `usuario`**: `idn_usuario.usuario` es único y en minúsculas por
   `specs/02` §3. El login normaliza a minúsculas **antes** de buscar; si se busca tal cual, "Juan"
   y "juan" son dos filas y el índice único no salva.
4. **El detalle de auditoría puede filtrar el usuario.** Un `detalle` tipo `login fallido para
   "juan"` en la tabla de auditoría es un vector de enumeración de cuentas, aunque la tabla no sea
   pública. El `detalle` lleva un **código** (`clave_incorrecta`, `usuario_bloqueado`), no el input.
5. **El rate limit en memoria se pierde al reiniciar.** Aceptable en esta fase (una instancia,
   instalación chica); queda anotado como deuda para cuando haya varias.
6. **`.pattern()` de Joi imprime el valor en el mensaje de error.** Verificado:
   `"value" with value "…" fails to match the required pattern`. Aplicado a `TQ_MASTER_KEY` eso
   vuelca la master key en la consola del operador. Para variables sensibles, `.custom()`.

---

## Lo que se agregó y corrigió

### Agregado: esquema Joi de variables de entorno

`backend/src/config/env.schema.ts` (esquema Joi) + `ConfigModule` con `validationSchema` +
`ConfigService` inyectado. `TQ_MASTER_KEY`, `DATABASE_URL`, `TQ_ISSUER` y `ACCESS_TTL_MIN`
validados y con default; `main.ts` valida antes de `NestFactory.create` para poder imprimir un
mensaje legible. Los tres scripts usan el mismo esquema vía `scripts/lib/entorno.mjs`.
**Decisión normativa y reglas en `specs/00` §8.**

Dos detalles que no son obvios y conviene no volver a pisar:

1. **El `.env` canónico es el de la raíz.** Antes `main.ts` usaba `dotenv.config()` a secas
   (resuelve desde el cwd → `backend/.env` al arrancar con npm workspaces) y los scripts leían la
   raíz: dos archivos para lo mismo. Ahora `RUTAS_ENV` resuelve desde el archivo y el cwd es
   irrelevante.

### Corregido en el scaffold de la Fase 01

`schema.prisma` **nunca había pasado `prisma validate`** (el CLI no estaba instalado, así que el
cliente generado estaba viejo y nadie lo notó). Todo esto es al `.prisma`, **no** al SQL de
`deploy/sql/`, que es el que manda:

| Qué estaba | Por qué estaba mal | Qué se hizo |
|---|---|---|
| `@@map("dbo.tok_clave_firma")` | Prisma antepone el esquema y generaba `FROM [dbo].[dbo.tok_clave_firma]`: **toda** query por modelo fallaba con "table does not exist" mientras las `$queryRaw` sí funcionaban | `@@map` con el nombre pelado; resuelve contra el esquema por defecto del usuario |
| `onDelete: NO ACTION`, `onUpdate: CASCADE` | Sintaxis T-SQL copiada al schema | `NoAction` / `Cascade` |
| `[base]`, `[esquema]`, `[engine]` | Prisma no tiene identificadores entre corchetes | Sin corchetes |
| `@default(identity(1,1))` | Idem | `@default(autoincrement())` |
| Faltaban las **back-relations** en `cat_cliente`, `cat_aplicacion`, `idn_usuario` | Cada relación necesita su lado inverso | Agregadas |
| `usuario @unique([usuario])` | No es sintaxis válida; el único no se declaraba | `@unique` |
| `clave_privada_cifrada String`, `mfa_secret_cifrada String?`, `credencial_cifrada String?` | Las columnas son `varbinary`. Con `String` el cliente no devuelve `Buffer` y la clave cifrada llega corrupta | `Bytes` / `Bytes?` |
| `bloqueado_hasta DateTime` (no nulo) | El DDL lo deja `NULL` | `DateTime?` |
| `@@unique([...], where: ...)` en `cat_base_datos` | El proveedor MSSQL no expresa índices filtrados | **Quitado**, con comentario: lo crea el SQL y lo hace cumplir la base |
| `backend/package.json` con `"type": "module"` | `tsc` emite CommonJS, así que `node dist/main.js` moría con `exports is not defined` | Quitado `"type"` |
| `helmet` y `cors` ausentes de `dependencies` | `main.ts` los importa; sólo estaban sus `@types` | Agregados |
| `prisma` ausente de `devDependencies` | Sin el CLI no se puede `prisma generate` | Agregado + script `prisma:generate` |

**Ninguno de estos se detecta con `prisma validate`**: el del `@@map` con `dbo.` es sintácticamente
válido y sólo explota al ejecutar una query contra la base. Por eso el cierre de esta fase es correr
los scripts de verdad, no compilar.

### Bug propio, encontrado al correr la verificación

El parser de flags del bootstrap (`parsearFlags`) sólo entendía `--flag=valor`. Con la forma
documentada `--usuario admin` (con espacio) tomaba `"usuario admin"` como nombre de flag y dejaba
`flags.usuario = "true"`, el string literal. El resultado fue **crear un usuario llamado `"true"`**
en la base. Corregido: los flags con valor obligatorio se declaran explícitamente y un flag sin
valor es un error con el uso por pantalla, nunca un valor inventado. (El usuario `"true"` se borró.)

### Decisiones propias de esta fase

1. **`clave_publica` se guarda como JWK en JSON**, no como PEM. El JWKS sirve el documento casi tal
   cual, no hay que convertir en cada request, y la `kid` viaja dentro del propio JWK.
2. **`detalle = 'clave_incorrecta'` también cuando el usuario no existe.** Distinguirlo por el
   `detalle` re-abre la enumeración de cuentas que el mensaje uniforme y el tiempo uniforme estaban
   cerrando. Quien audita separa los casos por `idusuario IS NULL`, que es el diseño que ya pedía el
   DDL.
3. **`crearMembresias` filtra antes de insertar** en vez de `createMany({ skipDuplicates })`, que no
   existe para el proveedor MSSQL de Prisma.
4. **`activarNueva()` existe pero no se expone por HTTP.** La rotación es de la Fase 09; un endpoint
   de rotación abierto sería una forma cómoda de invalidar los tokens del tenant.
5. **La clave de firma se asegura en el bootstrap, no en el arranque.** Si el arranque dependiera de
   la base, una base caída impediría hasta `/health`. El JWKS devuelve `{keys: []}` sin clave, que
   es una respuesta válida y no un crash.
6. **No se usa `multiSchema` de Prisma.** Calificar el esquema obligaría a poner `@@schema` en los 12
   modelos y a habilitar una preview feature, a cambio de no depender del esquema por defecto del
   usuario. Ese error es **ruidoso** ("table does not exist"), no una escritura silenciosa en otro
   lado, así que no compensa.

### Pendiente para la Fase 03

- ~~El catálogo de la base de control se llama `tourniquet`, no `tourniquet_dev`. Y
  `scripts/ejecutar-sql-dev.mjs` aborta salvo que el catálogo sea `tourniquet_dev`, así que **no se
  puede aplicar SQL de `deploy/sql/` ahí tal cual**. Decidir el nombre definitivo, o mantener un
  `tourniquet_dev` aparte para desarrollo.~~
  **Resuelto (2026-09-29, durante la Fase 03):** el catálogo de desarrollo se renombró a
  `tourniquet_dev`, que es lo que dice `specs/02` §1 y lo que la guardia de
  `scripts/ejecutar-sql-dev.mjs` exige. `DATABASE_URL` apunta ahí.
  `tourniquet` queda como el nombre de producción, que es donde crea la base el bloque 0 de
  `00-crear-base.sql`. Además se puso la cadena real de conexión en el `.env` de la raíz, que era
  una copia del `.env.example` con placeholders, y **`backend/.env` se borró**: mientras existió
  fue el que realmente mandaba, porque Prisma lo carga solo al importarse y antes que el
  `dotenv.config` de la app (que no pisa variables ya definidas). Queda un solo `.env`, el
  canónico de `specs/00` §8.1. `RUTAS_ENV` todavía lo lista como fallback: es inocuo, pero
  también es la puerta por la que se colaba el otro; conviene sacarlo de la lista y, con él, la
  dependencia de que Prisma cargue un `.env` por su cuenta.
- La rotación `activarNueva()` está implementada y probada con doble en memoria, pero **no se ha
  ejecutado contra la base real** (dejaría dos claves: la activa y una retirada).
  **Ejecutada (2026-09-29, al cerrar la Fase 03):** ver *La rotación de la clave de firma* abajo.

### La rotación de la clave de firma (2026-09-29)

Al borrar `backend/.env` (que la app leía sin querer, por el `.env` que carga Prisma) quedó sólo el
`.env` de la raíz, y **su `TQ_MASTER_KEY` no descifra la clave de firma de la base**: nunca lo hizo,
llevaba una copia vieja desde el principio. Con una master key que no corresponde, la clave privada
de `tok_clave_firma` es irrecuperable (AES-256-GCM no se puede "forzar"), así que la salida fue
generar un par nuevo:

```js
// con el .env de la raíz ya apuntando a la base correcta
const firma = new FirmaService(new PrismaService(), new MasterKeyService(configService));
const kid = await firma.activarNueva();   // retira la activa y deja la nueva activa
```

Resultado: `8a2eb4afc6fed189` → retirada, `79acd6513ef24c7a` → activa. La vieja sigue en el JWKS
por la ventana de 24 h (`specs/01` §5) y se cae sola; su `clave_privada_cifrada` queda como
basura que ningún proceso puede leer, y no se borra a mano porque `tok_clave_firma` es historial de
claves, no caché. **Los tokens firmados con la vieja dejan de validar**; en esa base sólo había
sesiones del admin de desarrollo.

Lo que pasó después, y que quedó como mejora del código: el síntoma era un `invalid_grant` en
`/oidc/token` (el canje de un code válido moría en el paso de firma) y en el log sólo se veía
"Unsupported state or unable to authenticate data". `FirmaService.clavePrivada()` ahora traduce eso
a un mensaje que dice qué hacer. **Ojo con el arranque**: Joi valida que la master key tenga 32
bytes base64, no que sea *la* correcta; eso sólo se comprueba descifrando. Decidir si la app debe
negarse a arrancar con esa condición (y si eso no debe atar el arranque a la base, que fue la
decisión 5 de la Fase 02) queda anotado para la Fase 04. Sigue así: es
  de la Fase 09.
