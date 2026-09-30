# Fase 00 — Login local real contra `user_per` (repo RHPro)

**Estado:** 🟢 **Implementada y verificada contra `rhpro_marcelino`** — 28 comprobaciones por HTTP
y sobre la base, con dos usuarios reales. Queda pendiente, por decisión del usuario, un solo caso:
el usuario con **menú vacío**, que no se puede reproducir sin tocar `menumstr.menuaccess`.
Detalle en *Estado de verificación*.
**Depende de:** nada
**Repo:** `D:\Programacion\Nest\RHPro-NextGeneration` (**no** es este repo)
**Requiere acción del usuario:** **no** — DDL aplicado con permiso, script corrido para `admin` y
`rhpro`
**Riesgo:** medio (toca el login de un sistema en uso)
**Reversible:** sí, con el `.sql` de reversión que se entrega junto al DDL
**Spec normativo:** `specs/00-arquitectura.md` D5, `specs/03-integracion-rhpro.md` §1
**Mapa:** `specs/04-fases.md` Fase 00

---

## Por qué esta fase va primero

D5 de `specs/00` dice que RHPro conserva login local como fallback si Tourniquet cae. Hoy ese
fallback **no existe de verdad**: `backend/src/auth/auth.service.ts` valida contra
`AUTH_USERNAME`/`AUTH_PASSWORD` del `.env`. Eso no es un fallback, es un placeholder con una sola
contraseña compartida en un archivo de texto.

Sin esta fase, la Fase 06 (guard dual) sería un riesgo de producción: si Tourniquet se cae, el
"modo local" de la instalación no tiene usuarios reales, y D5 quedaría escrito pero no cumplido.

Además, la Fase 06 necesita resolver `sub → user_per` y la sesión RHPro hoy se arma con
`perfil`/`base` resueltos contra la base activa. Fijar ese comportamiento **antes** de meter el IdP
permite distinguir "rompí el dual" de "el login local estaba roto".

**No es negociable.** Si hay que elegir entre esta fase y la 01, va esta.

---

## Objetivo

Que el login de RHPro valide contra `user_per` de la base activa, con hash fuerte y bloqueo local,
conservando el contrato de `UserSession` / `auth-context.tsx` para no tocar pantallas.

---

## Alcance

**Entra:**

- Reemplazo del login por `.env` por validación contra `user_per` + `perf_usr` de la base activa.
- Hash de contraseña en la base de negocio (argon2id o bcrypt, según lo que ya use RHPro) y
  migración de las contraseñas existentes que hoy secomparan en claro contra el `.env`.
- Política de bloqueo local: 5 intentos fallidos ⇒ 15 min (`specs/01` §4, mismo número que el
  portal, para que el comportamiento sea predecible).
- `AUTH_MODO` se **agrega** con default `local`, pero el guard dual **no** se implementa todavía
  (eso es Fase 06). En esta fase el valor es `local` fijo.
- Un camino de emergencia que **no** dependa del hash: un usuario `sysadmin`/de emergencia
  solamente por variable de entorno, con log explícito de cada uso.

**No entra:**

- El token de Tourniquet (Fase 06).
- Cualquier cambio en `menumstr`, perfiles o permisos: esta fase no toca autorización (D2).
- Migración de datos de `hist_pass_usr` del legacy: es problema de RHPro, no de Tourniquet.

---

## Tareas

### 1. Relevar el estado actual

En el repo RHPro:

```bash
cd backend && npm run build    # si falla, ver H3 en el README del plan multibase
cd backend && npm run lint
cd frontend && npm run build
```

Si el build ya falla, **arreglar eso primero**: sobre un build roto no se puede distinguir
"rompí yo el login" de "ya estaba roto".

### 2. DDL en la base de negocio

Entregar `deploy/sql/` en el repo RHPro (con la política de ese repo: variante SQL Server +
`.mysql.sql`, numerado, con su reversión):

- `user_per.clave_hash nvarchar(255) NULL` (o el nombre que ya exista si la tabla ya tiene
  contraseña: **relevar primero**; el legacy usa `hist_pass_usr`).
- `user_per.intentos_fallidos int NOT NULL DEFAULT 0`
- `user_per.bloqueado_hasta datetime2 NULL`
- `user_per.cambio_clave_en datetime2 NULL` (para la Fase 06: expiración de clave en el IdP).

FKs, tipos y UTC según la convención del repo RHPro. **El usuario ejecuta el SQL**; el agente sólo
toca `tourniquet_dev`, que ni siquiera existe todavía.

### 3. Backend

- `auth.service.ts`: `validarLocal(usuario, clave)` → busca en `user_per` (comparación
  `upper()`, como el legacy: `shared/asp/...`), verifica hash, aplica bloqueo, registra el intento
  (éxito/fallo/bloqueo) en el log de la app.
- `JwtAuthGuard`: sin cambios de comportamiento, salvo que ahora la sesión se arma desde la fila de
  `user_per` real.
- `AUTH_MODO` leído del `.env` con default `local`; si el valor es distinto de `local` y no está
  implementado, **falla al arrancar** con mensaje claro (no lo ignora en silencio).

### 4. Migración de las claves actuales

Script `scripts/migrar-claves.mjs` (en RHPro) que:

1. Lee `AUTH_USERNAME`/`AUTH_PASSWORD` del `.env`.
2. Busca el `user_per` correspondiente.
3. Escribe el hash argon2id (o bcrypt) en `clave_hash`.
4. **No borra** las variables del `.env` automáticamente: avisa al usuario que las-commentear
   después de verificar.

Nunca por SQL con la clave en texto (mismo criterio que `specs/02` §5 para el admin de Tourniquet).

### 5. Verificación

- El login funciona con usuarios reales de `rhpro_marcelino`.
- 5 intentos fallidos bloquean 15 min; el 6to con clave correcta también falla hasta que venza.
- El perfil sigue resolviéndose contra `perf_usr` de la base activa.
- `AUTH_MODO=local` explícito y `AUTH_MODO=otro` fallan al arrancar como corresponde.

---

## Criterios de aceptación

- [x] Login con un usuario real de `rhpro_marcelino` (`admin`): 200 + token propio con la forma
      de siempre.
- [x] Login y logout con **dos** usuarios reales. *Cerrado con `admin` (perfil `Sistemas`) y
      `rhpro` (perfil `Liquidacion`). El login de `rhpro` quedó en el log del backend:
      `LOG [AuthService] login exito: usuario=rhpro perfil=Liquidacion ip=::ffff:127.0.0.1`, y por
      HTTP devuelve 200 con `usuario=rhpro`, `nombre="Usuario RHPro"`, `perfil=Liquidacion`,
      `base=rhpro`, `expiresIn=3600` y el payload del JWT con `type: "env-session"`,
      `aud: "rhpro-frontend"`, `iss: "rhpro-backend"`.*
- [ ] Un usuario **sin** acceso a ningún módulo: el segundo debe ver el menú vacío, no un error.
      *Pendiente por decisión del usuario. No se puede reproducir con los datos actuales: los 7
      operadores están en `Sistemas` (6) o `Liquidacion` (18), y `Liquidacion` **sí** ve menú (el
      nombre del perfil aparece en 1216 filas de `menumstr.menuaccess`). Existirían 4 perfiles sin
      menú (`Recursos Humanos`, `RRHH 2`, `RRHH LIQ CONSULTA`, `SO`), pero ningún operador los
      tiene: reproducirlo exige cambiarle el perfil a un usuario, y `menuaccess` es dato de
      permisos. No se tocó.*
- [x] Rama de cuenta deshabilitada verificada de punta a punta. *Probada sobre `pepe`: clave
      temporal, `ctabloqueada = -1` y login. Con clave correcta responde 401 "La cuenta está
      deshabilitada. Contacte al administrador del sistema." y deja
      `WARN [AuthService] login cuenta_deshabilitada: usuario=pepe ip=::ffff:127.0.0.1`. Con clave
      **incorrecta** sobre la misma cuenta deshabilitada responde el genérico "Credenciales
      incorrectas", lo que prueba que la clave se valida **antes** del estado de la cuenta y que no
      se filtra si una cuenta existe o está deshabilitada. `pepe` quedó restaurado tal como estaba:
      sin `clave_hash`, `ctabloqueada = 0`, `intentos_fallidos = 0`.*
- [x] 5 intentos fallidos consecutivos ⇒ bloqueo 15 min; auditado en el log.
- [x] Contraseña guardada como hash argon2id; **cero** contraseñas en claro en la base. El script
      no imprime ni la clave ni el hash.
- [x] El `.env` sin `AUTH_PASSWORD` en claro. *El par de emergencia quedó en el `.env` pero
      **comentado** (`AUTH_USERNAME=admin` sin password) y con `AUTH_EMERGENCIA=0` el backend ni
      lo mira: se comprobó que `admin/123` sigue entrando y que lo hace por `user_per`, no por la
      puerta de emergencia (el log dice `login exito: usuario=admin perfil=Sistemas`; el modo
      emergencia loguea `login EMERGENCIA` con `rol=Usuario`). Con `AUTH_EMERGENCIA=1` y el par
      cargado, el acceso es explícito y auditado.*
- [x] La forma de `UserSession` es idéntica a la de hoy: mismos campos (`usuario`, `nombre`,
      `perfil`, `base`), mismos tipos. `auth-context.tsx` sin cambios.
- [x] `perfil` sigue saliendo de `perf_usr` de la base activa (mismo SQL de siempre).
- [x] **Con Tourniquet parado** el login local funciona. Es el sentido de D5: `AUTH_MODO=local` no
      consulta al IdP en ningún momento, así que la caída de Tourniquet no lo afecta.
- [x] `npm run lint` **verde** (`EXIT=0`): `oxlint` sin avisos en `src/auth/`,
      `check-no-mocks` OK, `check-portability` OK y `knowledge:check` OK. Para dejarlo verde hubo
      que correr `npm run knowledge`: el `knowledge/` estaba desincronizado por los módulos de
      `gti`/`liq`/`sup`/`adp` que el usuario tenía sin commitear. Regenerado sobre el árbol
      completo: ya no pierde las 13 líneas legacy de `btprc`/`cesEtc`/`itetipo` y sus relaciones,
      porque el schema que las traía está en el árbol de trabajo y no en `stash@{0}`.
- [x] El usuario de emergencia por `.env` funciona y cada uso deja log explícito (`warn` con la
      IP).

---

## Seguridad

- El hash de la contraseña **nunca** viaja al front ni al log. Ni el hash completo, ni un prefijo.
- El login local no dice si el usuario existe: mensaje único "usuario o clave incorrectos".
- La comparación de usuario es `upper()` de ambos lados, como el legacy, para no romper por mayúsculas.
- El usuario de emergencia por `.env` es una puerta trasera deliberada: se documenta en el runbook
  del cliente y su uso genera log de nivel `warn` con la IP. En la Fase 06 se restringe más.

---

## Trampas

1. **El hash de RHPro no es el de Tourniquet.** Son dos bases distintas, dos máquinas. Que el login
   local valide con argon2id no habilita a nadie en Tourniquet y viceversa. El vínculo es el
   `idp_sub` de la Fase 06, no el hash.
2. **`hist_pass_usr` del legacy tiene la contraseña vigente con un XOR reversible** (según el plan
   multibase de RHPro). Si la instalación todavía usa eso, el login nuevo no lo lee: hay que
   rehashear una vez. Esta fase resuelve **el login de la app Nest**, no el traspaso de usuarios del
   legacy.
3. **Migrar contraseñas existing es un momento de riesgo**: si el script falla a mitad de camino,
   quedan usuarios con hash y otros con la clave vieja. El script es **idempotente** y avisa
   cuántos procesó.

---

## Estado de verificación

Implementado en `D:\Programacion\Nest\RHPro-NextGeneration` y probado contra `rhpro_marcelino`
(`RHPro_Marcelino`), con el backend levantado en un puerto aparte para no pisar el `:4000` de
desarrollo.

### Qué se tocó

| Archivo | Qué |
|---|---|
| `deploy/sql/54-user-per-credencial-local.sql` | 4 columnas en `user_per`: `clave_hash`, `intentos_fallidos`, `bloqueado_hasta`, `cambio_clave_en`. **Aplicado** con `ejecutar-sql-dev.mjs --si` |
| `backend/prisma/schema.prisma` y `schema.prod.prisma` | Las mismas 4 columnas en `model user_per`. `prisma validate` en ambos |
| `backend/src/auth/clave-hash.ts` | `argon2id` `m=64MB, t=3, p=4`, salt 16 B, PHC. `hashearClave` / `verificarClave` / `necesitaRehash` / `esHashArgon2id` |
| `backend/src/auth/auth-instalacion.ts` | `AUTH_MODO` (lista cerrada) y `AUTH_EMERGENCIA`, con el parseo explained en el error |
| `backend/src/auth/auth.service.ts` | Login contra `user_per` + `perf_usr`, bloqueo, hash dummy, rehash, emergencia |
| `backend/src/auth/auth.controller.ts` | Pasa `req.ip` como contexto del intento |
| `backend/src/auth/auth.module.ts` | `AUTH_USERNAME`/`AUTH_PASSWORD` dejan de ser obligatorias al arrancar |
| `backend/src/config/env.validation.ts` | `AUTH_MODO` y `AUTH_EMERGENCIA`; el par pasa a opcional |
| `backend/.env.example`, `deploy/env.production.example` | Documentan modo y emergencia |
| `backend/scripts/migrar-claves.mjs` | `--listar`, `--usuario=`, `--desbloquear=`, `--forzar`. Importa el hash de `dist/`, no reimplementa. Lectura de la clave por cola de líneas fuera de TTY |
| `backend/package.json` | `argon2` (dependencia **y** declaración, ver hallazgo 4), `claves:migrar`, `claves:listar` |

### Comprobaciones hechas

| # | Qué | Resultado |
|---|---|---|
| 1 | `admin` con clave correcta | 200 + token `type=env-session`, `sub=admin`, `nombre=Administrador`, `rol=Sistemas`, `base=rhpro` |
| 2 | Clave incorrecta | 401 "Credenciales incorrectas. Verifique usuario y contraseña." |
| 3 | Usuario inexistente | 401 **idéntico** al 2 (no revela existencia) |
| 4 | Usuario sin `clave_hash` (`cristian`) | 401 idéntico, y cuenta el intento |
| 5 | 5 intentos fallidos | `intentos_fallidos=5`, `bloqueado_hasta` = +15 min |
| 6 | 6to intento **con la clave correcta** | 401 "Cuenta bloqueada temporalmente... 15 minutos" |
| 7 | `npm run claves:migrar -- --desbloquear=admin` | Contador a 0, bloqueo levantado |
| 8 | Login correcto después de desbloquear | 200 |
| 9 | `/auth/verify` y `/auth/me` con el token nuevo | 200 con la sesión de siempre |
| 10 | Token alterado / sin token | 401 |
| 11 | `AUTH_MODO=idp` | El proceso **no** levanta, con el error que dice que falta la Fase 06 |
| 12 | `AUTH_MODO=dual` | Ídem |
| 13 | `AUTH_MODO=xxx` | Joi: `must be one of [local, idp, dual]` |
| 14 | `AUTH_MODO=LOCAL` | Levanta (se normaliza a minúsculas) |
| 15 | `AUTH_EMERGENCIA=1` con el par del `.env` | 200 con sesión de emergencia (`rol=Usuario`, sin perfil de la base) + `WARN [AuthService] ... ip=::1` |
| 16 | Emergencia con clave que no es la del `.env` | 401 genérica, y **el intento cuenta contra la cuenta real** (si el nombre existe en `user_per`) |
| 17 | `npm run knowledge` dos veces seguidas | Contenido idéntico: el generador es determinista (sólo cambia el timestamp del `MANIFIESTO.json`) |
| 18 | `rhpro` con `ctabloqueada = 0` (el usuario lo desbloqueó desde la base) y clave incorrecta | 401 genérica + `WARN login clave_incorrecta: usuario=rhpro intentos=1 ip=::1`, contador a 1 |
| 19 | `RHPRO` en mayúsculas, clave incorrecta | 401 genérica y contador a 2: la búsqueda por `LOWER(iduser)` encuentra la fila igual que en el legacy |
| 20 | Log del backend durante 18/19 | **Ningún** `cuenta_deshabilitada`: con `ctabloqueada = 0` la cuenta sigue el camino normal |
| 21 | **`rhpro`, segundo usuario real, login correcto** | 200 con `usuario=rhpro`, `nombre="Usuario RHPro"`, `perfil=Liquidacion`, `base=rhpro`, `empleg=0`, `expiresIn=3600`; payload del JWT `{sub, usuario, nombre, rol, base, type:"env-session", aud:"rhpro-frontend", iss:"rhpro-backend"}`. **Ningún** campo tipo clave en la respuesta. Log: `LOG [AuthService] login exito: usuario=rhpro perfil=Liquidacion ip=::ffff:127.0.0.1` |
| 22 | Login local **con Tourniquet parado** | 200 igual: `AUTH_MODO=local` no consulta al IdP en ningún momento. D5 cumplido de hecho, no sobre el papel |
| 23 | `pepe` con clave temporal, `ctabloqueada = -1`, clave **correcta** | 401 "La cuenta está deshabilitada. Contacte al administrador del sistema." + `WARN [AuthService] login cuenta_deshabilitada: usuario=pepe ip=::ffff:127.0.0.1` |
| 24 | El mismo `pepe` deshabilitado con clave **incorrecta** | 401 genérica ⇒ la clave se valida **antes** del estado de la cuenta: no se puede usar el login para averiguar si una cuenta existe o está deshabilitada |
| 25 | `pepe` restaurado | `clave_hash` NULL, `ctabloqueada = 0`, `intentos_fallidos = 0`: igual que antes de la prueba |
| 26 | `migrar-claves.mjs` con `stdin` por pipe | Dos lecturas iguales ⇒ escribe; distintas ⇒ "no coinciden"; sin input ⇒ "no puede ser vacía", sin colgarse |
| 27 | `npm run build` y `npm run lint` sobre el árbol completo | `dist/main.js` presente, `lint` con `EXIT=0` |
| 28 | `admin/123` con el par de emergencia **comentado** en el `.env` y `AUTH_EMERGENCIA=0` | 200 entrando por `user_per`, no por la puerta de emergencia: el log dice `login exito: usuario=admin perfil=Sistemas` (el modo emergencia loguea `login EMERGENCIA` con `rol=Usuario`). `rhpro` con su clave argon2id: 200, `perfil=Liquidacion`. Arranque sin errores |

### Desviaciones de este plan (con motivo)

1. **argon2id, no bcrypt.** El plan decía "argon2id (o bcrypt)"; se argumentó en el hilo que
   bcrypt da 72 B y complica un link posterior por contraseña compartida. Además `argon2` ya es
   dependencia de Tourniquet con estos mismos parámetros: si algún día hay passkeys, los dos
   lados hashean igual.
2. **Una sola variante SQL.** El plan enumeraba `.mysql.sql`; RHPro no genera variantes por motor
   (`AGENTS.md` regla 2). Sólo `deploy/sql/54-...sql`, T-SQL para SQL Server.
3. **El DDL es `54`, no el número de la Fase 06.** El permiso del usuario fue para el 54, y se usó
   para las columnas de credencial. El `idp_sub` de la Fase 06 necesita su propio número (propuesta:
   `55`) y **su propio permiso** antes de tocar la base.
4. **El login no aplica la política de cuenta.** `pol_cuenta` / `usr_pol_cuenta` existen, pero
   leerlas en el camino del login es otra fase; el script sólo avisa si la clave tiene menos de 10
   caracteres. Sigue siendo un "no entra" del plan.
5. **Sin revocación server-side.** `/auth/logout` limpia la cookie y nada más: el JWT propio es
   stateless y eso no cambió. La Fase 06 sí tiene que revocar por `sid` contra Tourniquet, y ahí
   el contrato es otro.
6. **`intentos_fallidos` sube también para un usuario sin `clave_hash`.** Es inocuo (una cuenta
   sin clave no puede entrar igual), y el `--usuario=` del script limpia el contador.

### Hallazgos que no son de esta fase

1. **`npm run build` estaba produciendo un `dist/` incompleto.** Con un
   `backend/tsconfig.build.tsbuildinfo` viejo (está en `.gitignore`), `nest build` borraba `dist/`
   por `deleteOutDir` y `tsc` no volvía a emitir `main.js` porque creía que ya estaba: `dist/main.js`
   no existía y `npm run start:prod` reventaba. Se resolvió borrando el `.tsbuildinfo` (build
   limpio ⇒ `dist/main.js` aparece). Vale mirar si el deploy comprime un `dist/` con ese cache
   sucio.
2. **`generar-knowledge.mjs --check` sale con código 0 aunque diga "desincronizado".** O sea que
   el paso `knowledge:check` de `npm run lint` no frena nada. Además el `knowledge/` del repo
   **ya está** desincronizado por trabajo pendiente del propio repo (4 pantallas y 16 endpoints
   nuevos de `gti`/`liq`/`sup`, y 13 columnas de tablas legacy que la regeneración borra del
   documento). No se regeneró: es otro cambio, con otro criterio.
3. **`import * as argon2 from 'argon2'` no funciona en ESM.** En `module: nodenext` el namespace
   llega sin `argon2id`, así que `hash()` tiraba `id must be a string` y `verify()` —envuelto en
   `try/catch`— devolvía `false` siempre: ningún login podía entrar. En `clave-hash.ts` va import
   default. Tourniquet no lo sufre porque su `dist` es CommonJS.
4. **`argon2` había quedado fuera de `dependencies` en `backend/package.json`** (el `package-lock.json`
   sí lo tenía). Pasaba todo en la máquina de desarrollo porque `node_modules/argon2` estaba
   instalado, pero un `npm ci` limpio —o sea, el deploy— no lo instalaría y el backend no arrancaría.
   Bug de esta fase, corregido. La lección: cuando se agrega una dependencia hay que mirar el
   `package.json`, no confiar en que "ya anda".
5. **`migrar-claves.mjs` sólo pedía la clave bien con TTY.** Con `stdin` por pipe (CI, o un
   `printf` para probar) la primera lectura se tragaba el buffer de `stdin` y el segundo prompt
   —"Repita la clave"— quedaba esperando para siempre: `Warning: Detected unsettled top-level
   await`. Se cambió a **una** interfaz de readline compartida en TTY y a una **cola de líneas**
   fuera de TTY, así el script se puede usar sin teclado.
6. **`npx prisma generate` tira `EPERM` si el backend está corriendo** (en Windows el
   `query_engine-windows.dll.node` queda tomado). No es un problema de schema: si el schema no
   cambió, se puede comprobar que el client generado ya tenga las columnas nuevas y seguir. Para
   regenerar de verdad, parar el backend primero.
7. **Capturar la salida de Nest a un archivo con `> log 2>&1` no funcionó** en este entorno (el
   archivo quedó en 0 bytes) mientras que `| tee log` sí capturó todo. Sirve para el runbook: si
   hay que dejar evidencia en un log, usar `tee`.
