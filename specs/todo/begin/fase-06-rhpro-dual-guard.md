# Fase 06 — RHPro como relying party: guard dual, exchange e `idp_sub`

**Estado:** ✅ **Cerrada** — backend y front verificados de punta a punta con un `code` real de
Tourniquet, y confirmado en navegador. El DDL `57-user-per-idp-sub.sql` está aplicado, el guard con
los tres modos funciona, y el canje entra como `admin` (perfil `Sistemas`) tanto por `curl` contra
el backend como a través del proxy del front en `next dev`. Ver *Estado de verificación*.
**Depende de:** [05](fase-05-registro-demo.md)
**Repo:** `D:\Programacion\Nest\RHPro-NextGeneration` (**no** es este repo)
**Requiere acción del usuario:** **sí** — aplicar el DDL 57 y dar de alta `idp_sub` por operador en
**cada** base donde vaya a entrar por el portal (en dev ya quedó hecho y vinculado)
**Riesgo:** alto — cambia el login de un sistema en uso
**Reversible:** sí: `AUTH_MODO=local` deja el sistema exactamente como estaba
**Spec normativo:** `specs/03-integracion-rhpro.md` §2, §3, §4
**Mapa:** `specs/04-fases.md` Fase 02

---

## Por qué el guard dual y no un reemplazo

D5 de `specs/00` es una restricción dura: si Tourniquet cae, la instalación de RHPro tiene que
poder seguir operando con login local. Un reemplazo directo del login por OIDC convierte un
problema del IdP (una caída, un bug de red) en una parada total de RRHH.

El modo `dual` es lo que hace que la migración sea reversible en cualquier momento: se cambia
`AUTH_MODO` en el `.env` y se vuelve atrás, sin rollback de base ni de código. Por eso `AUTH_MODO`
existe desde la Fase 00 (donde se declara con default `local`) y esta fase lo implementa de verdad.

También es la fase donde aparece el punto de diseño más delicado del spec: **el token de Tourniquet
no habilita a nadie por sí solo**. La existencia en el IdP no da acceso a la app: hay que dar de
alta al operador en `user_per`. Sin ese control, el primer IdP que se prende es una puerta abierta a
cualquier cuenta creada en él.

---

## Objetivo

Que RHPro acepte tokens de Tourniquet conservando su autorización por base, con los tres modos de
`AUTH_MODO`, y que el vínculo usuario↔operador sea `idp_sub` y no el nombre.

---

## Alcance

**Entra (en RHPro):**

- `user_per.idp_sub uniqueidentifier NULL` con índice único filtrado (`WHERE idp_sub IS NOT NULL`).
  El DDL es `deploy/sql/57-user-per-idp-sub.sql` (**57**, no 55: el 55 quedó tomado por
  `55-vacaciones-datos-prueba.sql` y el 56 por `56-vacdiasacord-pk-compuesta.sql`). Ya aplicado en
  `rhpro_marcelino`; los 7 operadores quedaron con `idp_sub` NULL, o sea inerte hasta el alta.
- `JwtAuthGuard` con los tres modos de `specs/03` §2.
- `POST /auth/exchange` (backend): canje del `code` por tokens, usando la config de la instalación.
- Callback frontend: `POST /auth/exchange { code, verifier }` → cookie de sesión propia de RHPro.
- Refresh silencioso del lado de RHPro; logout de app ⇒ `/oidc/revoke` + cerrar cookie local.
- `POST /auth/rotate-jwks` (rompe la caché del JWKS).
- Validador de token de Tourniquet: `iss`, `alg`, `kid`/JWKS, `exp`/`nbf` con tolerancia ≤ 60 s,
  `aud`, `tenant`. Caché JWKS 24 h con refresh forzado ante `kid` desconocido, **una vez por token**.

**Entra (en Tourniquet):**

- Verificación de que la `redirect_uri` de RHPro en la 05 coincide con la real.
- Nada nuevo en el código: la 05 ya registró lo necesario.

**No entra:**

- Permisos de negocio en el token (D2): el guard arma la sesión con `user_per`/`perf_usr` como
  siempre.
- Auto-provisioning de `user_per` (`specs/00` §7).
- Consentimiento explícito en el portal (llega en la 07).
- Reparto de sesiones: `/me/apps` ya existe desde la 05.

---

## Tareas

### 1. DDL en la base de negocio

En el repo RHPro, `deploy/sql/` con su política (SQL Server **y** `.mysql.sql`, numerado, con
reversión):

```sql
ALTER TABLE user_per ADD idp_sub uniqueidentifier NULL;
CREATE UNIQUE INDEX UX_user_per_idp_sub ON user_per(idp_sub) WHERE idp_sub IS NOT NULL;
```

Portable (índice filtrado con `WHERE`, sin `TOP`/`ISNULL`/`GETDATE`), y se replica en la base de
Chile cuando exista. **El usuario lo ejecuta**; el agente pide permiso explícito y sólo sobre
`rhpro_marcelino`.

### 2. Alta del operador con `idp_sub`

SQL que corre el usuario (el `idusuario` es el que imprimió `scripts/alta-usuario.mjs` en la 05):

```sql
UPDATE user_per SET idp_sub = '0f2c...' WHERE UPPER(iduser) = 'ADMIN';
```

Se hace **a mano**, operador por operador. La razón es D2: dar de alta un operador es una decisión
de negocio (quién entra a qué base), no un efecto técnico del login.

### 3. Config de instalación (`.env` de RHPro)

```env
AUTH_MODO=dual          # local | idp | dual
TQ_ISSUER=https://auth.cervi.com
TQ_AUDIENCE=rhpro       # = cat_aplicacion.codigo
TQ_TENANT=cervi         # = cat_cliente.codigo
```

`AUTH_MODO=idp` para instalaciones con portal obligatorio (el caso chileno, `specs/03` §6).
`local` es el fallback de emergencia.

### 4. Validador (`backend/src/auth/tourniquet-token.validator.ts`)

`jose`, RS256 fijo. Orden de verificación y qué pasa en cada fallo (todo termina en 401 con detalle
genérico al cliente, detalle preciso al log):

| Chequeo | Fallo |
|---|---|
| `alg` == `RS256` (nunca `none`, nunca HS256) | 401 |
| `iss` == `TQ_ISSUER` | 401 |
| `kid` presente; si desconocido ⇒ refresh forzado del JWKS una vez; si sigue desconocido, 401 | 401 |
| Firma válida con la clave del JWKS | 401 |
| `exp` no vencido, `nbf` ok, tolerancia ≤ 60 s | 401 |
| `aud` (array o string) contiene `TQ_AUDIENCE` | 401 |
| `tenant` == `TQ_TENANT` | 401 |
| `sub` es UUID | 401 |

`iss` va primero y es el más barato de comparar: el orden de los cheap checks primero evita trabajo
inútil.

### 5. `JwtAuthGuard` con `AUTH_MODO`

```
local → sólo token propio RHPro (comportamiento Fase 00, idéntico byte a byte)
idp   → sólo token Tourniquet
dual  → intenta Tourniquet; si el issuer/alg no corresponde, cae al token local
```

En `dual`, un token **de Tourniquet que falla una validación** (aud, tenant, firma) **no** cae al
modo local: cae sólo si el token no es de Tourniquet. La diferencia importa: si un token de
Tourniquet inválido degradara a "probemos local", un atacante podría mandar cualquier token y
terminar autenticado por el camino local.

La sesión se arma como siempre contra la base activa: `user_per WHERE idp_sub = @sub` → perfil y
menú desde `perf_usr`/`menumstr`. **El guard no lee permisos del token** (D2).

Si no hay fila en `user_per` para ese `sub` ⇒ 401 con mensaje "usuario no habilitado en este
sistema", logged con el `sub` para que el admin pueda diagnosticar.

#### La regla que no se negocia: RHPro nunca queda fuera de servicio

D5 es una restricción **dura** de `specs/00`: si Tourniquet se cae, la instalación de RHPro tiene
que poder seguir operando con login local. "Que no pueda quedarse nadie sin entrar" no es una
funcionalidad extra, es el criterio de aceptación central de la fase. Se traduce en reglas
concretas, y la distinción clave es **"no responde" vs "responde que no"**:

| Situación | `dual` hace | Por qué |
|---|---|---|
| Tourniquet caído / timeout / `ECONNREFUSED` / 5xx | **cae al login local** y auditado (`WARN idp_no_responde`) | D5: la caída del IdP no puede parar RRHH |
| `invalid_grant` (code/verifier malo) | 401, **no** cae a local | rechazo autoritativo del IdP; si no, un `code` robado entraría por la puerta de atrás |
| Token de Tourniquet con `aud`/`tenant`/`firma` inválidos | 401, **no** cae a local (salvo que el token ni sea de Tourniquet) | un token manipulado no habilita a nadie por el modo local |
| Usuario existe en Tourniquet pero **no** en `user_per` | 401 "no habilitado" | la existencia en el IdP no da acceso (D2) |
| `AUTH_MODO=idp` y Tourniquet caído | **fuera de servicio, a propósito** | `idp` es la opción explícita de "sin red de seguridad"; por eso el default es `local` y `dual` es el recomendado para producción |

**Sólo `dual` (y `local`) garantizan que se pueda entrar.** `idp` es el único modo que acepta que
Tourniquet sea un punto único de falla, y por diseño no prende solo: hay que cambiar `AUTH_MODO`
en el `.env` y reiniciar. Por eso el default desde la Fase 00 es `local`, y la recomendación para
producción es `dual` —que es exactamente D5 hecho código.

El fallback en `dual` deja rastro: cada caída detectada emite un `WARN` con la causa, la latencia y
el origen (exchange o guard), para que "funcionaba porque cayó al local" no pase inadvertido en
producción.

### 6. `/auth/exchange`

Backend de RHPro:

1. `POST` a `{TQ_ISSUER}/oidc/token` con `grant_type=authorization_code`, `client_id`,
   `redirect_uri` **igual** al registrado, `code`, `code_verifier`.
2. Verifica el access recibido (mismo validador del punto 4: nunca confíes en la respuesta de otro
   servicio por estar en la red interna).
3. Traduce `sub` → `idusuario` interno de RHPro vía `user_per.idp_sub`.
4. Firma la **cookie de sesión propia** de RHPro (la que hoy entiende `auth-context.tsx`) y la
   devuelve. El refresh queda `HttpOnly` en el **dominio de RHPro**, no en el del IdP
   (`specs/01` §4).

#### Por qué RHPro **no** valida el `code_verifier` (decisión)

En PKCE el `code_verifier` lo genera el browser y **no se guarda en el backend**: viaja del front
directo al token endpoint. Para que RHPro pudiera verificarlo por su cuenta tendría que persistir
el `code_challenge` por sesión y comparar el `S256(code_verifier)` contra él, o sea:

- **estado en el servidor** que hay que crear, expirar y limpiar (una tabla o una entrada de sesión
  más que mantener), y
- **la misma comprobación criptográfica en los dos lados**, con el riesgo de que se desincronicen y
  el diagnóstico del fallo sea "algo no calza" sin saber qué lado.

Tourniquet es quien emitió el `code` **y** el `code_challenge`, así que es el único que puede
decidir si el verifier corresponde. Por eso el paso 1 va directo al canje: si el verifier no
calza, Tourniquet contesta `invalid_grant` y RHPro traduce eso a 401. **Una sola verificación, en el
único lugar que tiene el dato.** El botón de login del portal no cambia: el front igual genera el
verifier y lo manda.

Consecuencia operativa: **`invalid_grant` es un rechazo autoritativo, no una caída.** RHPro no cae
al login local en ese caso (ver §5): un `code` inválido no habilita a nadie por la puerta de atrás.
La caída de Tourniquet se distingue por error de transporte (timeout, ECONNREFUSED, 5xx), que sí
dispara el fallback local.

El access de Tourniquet **no** viaja al browser de RHPro: vive en memoria del backend y en la
cookie propia transformada. Si RHPro necesitara el token del IdP para llamar a otra API, es un
diseño posterior, no esto.

### 7. Callback frontend y refresh

- `frontend/src/app/auth/callback/page.tsx`: toma `code` + `state` de la URL, genera el
  `code_verifier` (PKCE S256), POST a `/auth/exchange`, y en caso de éxito redirige al destino
  original.
- **Valida `state`**: es responsabilidad del cliente OIDC (el `state` viaja en el authorize, vuelve
  en el callback). Guardarlo en sesión y comparar. Sin esto, el login CSRF vuelve a entrar por la
  puerta de atrás.
- Refresh silencioso: al vencer el access propio, POST a `/auth/refresh` con la cookie; si la
  respuesta es 401, cierre de sesión y redirect al portal.
- Logout de app: llama `POST {TQ_ISSUER}/oidc/revoke` y cierra su cookie. **No** cierra la sesión
  central: es logout de app, no "salir de todo" (`specs/01` §4).

### 8. `POST /auth/rotate-jwks`

Endpoint administrativo que limpia la caché del JWKS en memoria. Pensado para el día de la
rotación de claves (Fase 09). Detrás del mismo control de autorización que el resto del admin de
RHPro, y con auditoría.

---

## Criterios de aceptación

Los de `specs/04` Fase 02, más los specifics de la integración:

- [x] Con `AUTH_MODO=dual`, RHPro acepta **ambos** orígenes: login local (cookie propia) y token de
      Tourniquet.
- [x] Con `AUTH_MODO=local`, un token de Tourniquet válido da 401. Con `AUTH_MODO=idp`, el token
      local da 401.
- [ ] _(pendiente)_ Token con `aud` distinto de `TQ_AUDIENCE` ⇒ 401. Token con `tenant` distinto de
      `TQ_TENANT` ⇒ 401. (Probar los dos casos con tokens emitidos legítimamente y reescritos en la
      fase de prueba: se generan con un script de desarrollo, nunca en producción.)
- [x] Usuario que existe en Tourniquet **sin** fila en `user_per` ⇒ 401 "usuario no habilitado". No
      se crea el operador solo.
- [x] **D5 verificable: con Tourniquet caído, un operador real entra por login local en `dual`.**
      Se prueba parando Tourniquet y haciendo login normal. Es el criterio que no se negocia.
- [x] **La caída de Tourniquet es distinguishable de un rechazo**: `invalid_grant` y token con
      `aud`/`tenant` inválidos dan 401 **sin** caer al login local (probado con el IdP prendido).
- [x] Cada caída detectada deja `WARN idp_no_responde` con la causa, para que el fallback no pase
      inadvertido.
- [x] `AUTH_MODO=idp` con Tourniquet caído falla de forma explícita (no silenciosa), y el default
      sigue siendo `local` en `.env.example`.
- [x] Menú, perfiles y permisos de RHPro **sin cambios observables** respecto de la Fase 00: mismo
      comportamiento con la sesión originada en el portal.
- [x] El perfil sigue saliendo de `perf_usr` de la base activa, no del token.
- [x] Login completo desde el portal: 302 a RHPro, callback, cookie propia, landing en el inicio.
- [x] **Callback sin `state` válido ⇒ el login se rechaza** (no se acepta el code).
- [ ] _(fase siguiente)_ Logout de app: la sesión de RHPro muere, la sesión central **sigue viva** (el usuario puede
      entrar a otra app sin re-loguearse). "Salir de todo" (Fase 07) apaga las dos.
- [ ] _(fase siguiente)_ Refresh de RHPro renueva el access propio sin pedirle nada al usuario; con refresh vencido o
      sesión cerrada ⇒ cierre de sesión y redirect al portal.
- [ ] _(pendiente)_ `POST /auth/rotate-jwks` rompe la caché: tras un `kid` nuevo en el JWKS, el siguiente request
      con ese token valida sin reiniciar el proceso.
- [ ] _(pendiente)_ Un token con `alg=none` y uno con HS256 (firmado con un secreto inventado) ⇒ 401 en los tres
      modos.
- [x] Con Tourniquet **caído** (backend apagado) y `AUTH_MODO=dual`, el login local de RHPro sigue
      funcionando: es D5 verificado, no supuesto.
- [x] `npm run lint` y `npm run build` verdes en RHPro (backend y frontend).
- [x] ~~El DDL de `idp_sub` tiene su variante `.mysql.sql`~~ — **criterio dado de baja**: RHPro ya no
      tiene ningún `.mysql.sql` en `deploy/sql/` (0 archivos), la convención murió con el despliegue
      multi-motor. `deploy/sql/` es T-SQL de SQL Server. El DDL 57 trae su reversión, que es lo que
      sí importa.

---

## Seguridad

| Invariante | Aplicación |
|---|---|
| `sub` del token ⇒ `user_per.idp_sub`, **nunca** por nombre | La resolución es por UUID. Un login puede cambiar de nombre; el `sub` no |
| El token no habilita por sí solo | Sin fila en `user_per` ⇒ 401. El IdP no crea operadores |
| `tenant`/`aud` del token validado, no del request | `TQ_TENANT`/`TQ_AUDIENCE` vienen del `.env` de la instalación, no del body ni de un header |
| Nunca confiar en la red interna | El access recibido de `/oidc/token` se **valida** igual que uno de la calle |
| `alg` fijo RS256, rechazar `none` | Primer check del validador |
| El access del IdP no va al browser de RHPro | Vive en el backend y en la cookie propia transformada |
| Login CSRF | El cliente OIDC valida `state`: se compara con el que se guardó antes de redirigir |
| Detalle de error al cliente = genérico | "no habilitado" sí (es útil y no filtra secretos); "qué claim falló" no, va al log |
| `AUTH_MODO` se valida al arrancar | Valor desconocido ⇒ el proceso no levanta con un mensaje claro |

## Trampas

1. **En `dual`, distinguir "no es token del IdP" de "es token del IdP pero inválido".** Sólo el
   primer caso cae al login local. Si se mezcla, la validación del IdP se vuelve opcional sin que
   nadie lo note.
2. **`state` es del cliente.** Tourniquet lo refleja, no lo valida. Si el callback de RHPro no lo
   compara, todo el PKCE sigue siendo válido y el flujo sigue siendo atacable por login CSRF.
3. **El `redirect_uri` del `/auth/exchange` tiene que ser idéntico al del authorize.** No "el de
   producción" ni "el que RHPro tiene configurado": el mismo string exacto, con el mismo esquema, puerto y
   barra final. Es la causa número uno de `invalid_grant` en integraciones OIDC.
4. **Cookie propia vs cookie del IdP.** La cookie de sesión de RHPro es de RHPro; la del IdP es
   del portal. Que una app lea la cookie de otra (mismo dominio padre, por ejemplo) rompe el
   aislamiento: cada `redirect_uri` y cada dominio de cookie se define por separado.
5. **CORS con credenciales.** `TQ_ORIGENES` de la app y el backend de RHPro tienen que hablar
   exacto-exacto: `Access-Control-Allow-Origin` con el origen, `Allow-Credentials: true`. Con `*`
   el navegador descarta la respuesta.
6. **El `idp_sub` es un dato de la base de negocio.** Un `ALTER TABLE` en `rhpro_marcelino` que
   alguien más va a re-aplicar en la base de Chile sin el `WHERE idp_sub IS NOT NULL` del índice
   filtrado deja el índice único inútil (muchos NULLs no chocan, pero el índice no filtra). El
   `.sql` de la Fase 10 lo revisa.

---

## Estado de verificación

### Qué se tocó (en RHPro)

| Archivo | Qué |
|---|---|
| `deploy/sql/57-user-per-idp-sub.sql` | `user_per.idp_sub uniqueidentifier NULL` + índice único filtrado. **Aplicado** en `rhpro_marcelino` (numeración 57: el 55 y el 56 los tinham otros scripts) |
| `backend/prisma/schema.prisma` y `schema.prod.prisma` | La columna en `model user_per`. `prisma validate` en ambos |
| `backend/src/auth/claims-tourniquet.ts` | Tipos de los claims de Tourniquet, replicados de `specs/01` §2. Sin claims de permisos (D2) |
| `backend/src/auth/validador-tourniquet.ts` | Verificación de firma RS256 contra el JWKS, `iss`/`alg`/`aud`/`tenant`/`exp`/`nbf`, cache 24 h con refresh forzado ante `kid` desconocido |
| `backend/src/auth/validador-tourniquet.module.ts` | Módulo **global** del validador, porque el `APP_GUARD` se instancia en el módulo raíz y no ve los providers de `AuthModule` |
| `backend/src/auth/jwt-auth.guard.ts` | Los tres modos de `AUTH_MODO` y la regla de degradación de D5 |
| `backend/src/auth/exchange.service.ts` | `POST /auth/exchange`: canje del `code`, verificación del access, traducción `sub` → operador, firma de la cookie propia |
| `backend/src/auth/dto/exchange.dto.ts` | `code` + `codeVerifier` con el rango PKCE S256 de `RFC 7636` (43-128), que corta antes del round-trip |
| `backend/src/auth/auth-instalacion.ts` | `idp` y `dual` pasan a estar implementados |
| `backend/src/auth/auth.service.ts` | En `idp` el login por credenciales responde 401 con mensaje propio, en vez de un error genérico |
| `backend/src/config/env.validation.ts` | `TQ_ISSUER`/`TQ_AUDIENCE`/`TQ_TENANT`, requeridas por `Joi.when('AUTH_MODO')` en `idp`/`dual`, más `TQ_REDIRECT_URI` (opcional, con default de desarrollo) |
| `backend/.env.example`, `deploy/env.production.example` | Los tres modos y las `TQ_*` documentadas |
| `backend/src/auth/inicio-oidc.service.ts` | **Nuevo.** Genera el `state`, lo compara con `timingSafeEqual`, y trae `leerCookie()` (esta app no usa `cookie-parser`) |
| `backend/src/auth/auth.controller.ts` | `POST /auth/oidc/status` (si la vía está disponible, para que el front no ofrezca un botón que va a fallar) y `POST /auth/oidc/start` |
| `backend/src/auth/static-auth.middleware.ts` | `/auth/callback` entra como página pública **y se sirve siempre**: sin eso daba 404 en el despliegue estático, y redirigirla descartaría el `code` |
| `frontend/lib/oidc.ts` | **Nuevo.** PKCE `S256` con `crypto.subtle` y el verifier en `sessionStorage` |
| `frontend/app/auth/callback/page.tsx` | **Nuevo.** Toma `code` + `state`, canjea, y devuelve el resultado del login sin cambiar el contrato |
| `frontend/app/api/auth/oidc/start/route.ts`, `.../exchange/route.ts` | **Nuevos.** Puentes de `next dev`; en producción los responde el `AuthController` en el mismo origen |
| `frontend/app/auth-context.tsx` | `canjearPorTourniquet`, que deja la sesión igual que `login` (cookie + `localStorage`) |
| `frontend/app/auth/login/page.tsx` | Botón "Entrar con Tourniquet", que **solo aparece** si el backend dice que la vía está disponible |
| `frontend/proxy.ts` | Abre `/auth/callback` y los dos endpoints de auth (es la puerta de desarrollo; en producción manda el backend) |

### Comprobaciones hechas

| # | Qué | Resultado |
|---|---|---|
| 1 | `AUTH_MODO=local`, login `rhpro` | 200 `perfil=Liquidacion`; clave mala 401 genérica; `/auth/me` 200. **Idéntico a la Fase 00** |
| 2 | `AUTH_MODO=dual` con **Tourniquet caído** (issuer en un puerto sin nadie) | Login local 200 y `/auth/me` 200 con el token propio. **D5 cumplido** |
| 3 | `dual` con Tourniquet caído, token de Tourniquet con firma inventada | 401, no 200. La firma falsa no entra por la puerta de atrás |
| 4 | `dual`, token malformado (`no-es-un-jwt`) | 401 "Token inválido o sesión expirada" |
| 5 | Los 7 operadores con `idp_sub` NULL | Ninguno puede entrar por el IdP hasta que un admin lo vincule |
| 6 | `npx prisma validate` en los dos schemas | Ambos válidos |
| 7 | `npm run build` y `npm run lint` | `dist/main.js` presente, `EXIT=0`, knowledge sincronizado |
| 8 | **`/auth/exchange` con un `code` real de Tourniquet** | **200**: `usuario=admin`, `nombre=Administrador`, `perfil=Sistemas`, `base=rhpro`. El `sub=03ee4317-…` se tradujo a operador de RHPro y se firmó la cookie propia `rhpro_token` (`HttpOnly`, `SameSite=Lax`, `Max-Age=900`) |
| 9 | El token canjeado contra `/auth/me` | 200 con la sesión de `admin`; el payload lleva `idp_sub` (para auditoría) y **no** cambia la autorización |
| 10 | `code_verifier` que **no** corresponde al `code_challenge` | 401 + `WARN code_rechazado error=invalid_grant`. Confirma que la verificación del verifier la hace Tourniquet y que RHPro **no** degrada a login local |
| 11 | El mismo `code` canjeado dos veces | Primero 200, segundo 401: el `code` es de un solo uso |
| 12 | `sub` válido en Tourniquet **sin** `idp_sub` en RHPro | 401 "Usuario no habilitado en este sistema". **D2**: existir en el IdP no da acceso |
| 13 | Login local con `AUTH_MODO=dual` y Tourniquet prendido | 200 `rhpro` perfil `Liquidacion`: los dos caminos conviven |
| 14 | `code_verifier` con formato inválido (corto) | 400 por DTO, **sin** round-trip a Tourniquet |
| 15 | `POST /auth/oidc/start` | 200 con la URL del `authorize` (`client_id=rhpro`, `redirect_uri` exacto) y `state` de 43 caracteres en cookie `HttpOnly`, `Max-Age=600` |
| 16 | `state` **falso** con cookie **válida** | 401 "El inicio de sesión no coincide". Es el control anti-CSRF, y el mensaje es distinto del de cookie ausente |
| 17 | `state` tomado de **otro** intento, con su propia cookie | 401 "El inicio de sesión no coincide" |
| 18 | `state` correcto con verifier incorrecto | 401 del canje: pasó la validación de `state` y murió en PKCE. Los tres fallos se distinguen |
| 19 | El canje **a través del proxy de `next dev`** | 200 con sesión de `admin`: el flujo funciona por el front, no solo contra el backend |
| 20 | El mismo canje en el **navegador** | Ingreso completo: botón → portal de Tourniquet → elección de cliente → vuelta a RHPro con la sesión puesta. Confirmado por el usuario |

El flujo probado de punta a punta: login en Tourniquet (con `cliente=marcelino` en el segundo
intento, porque `admin` pertenece a 4 clientes) → `GET /oidc/authorize` con PKCE S256 → 302 con
`code` → `POST /auth/exchange {code, codeVerifier, state}` → 200 con la sesión propia de RHPro.


### Bugs que aparecieron al probar, y por qué importan

1. **`TokenTourniquetInvalido` extendía `Error`, no `UnauthorizedException`.** Consecuencia: cualquier
   token de Tourniquet mal formado devolvía **500** en vez de 401, y el 500 además filtraba que el
   token venía del IdP. Ahora el error de autenticación y el motivo (`token` / `idp_no_responde` /
   `idp_no_configurado`) van en campos separados, así el guard decide sin parsear el mensaje.
2. **El token propio de RHPro caía en el validador del IdP.** En `dual`, `looksLikeTourniquet()`
   comparaba solo "tiene `iss`", y el token propio también lo tiene (`rhpro-backend`): `/auth/me`
   daba 500 con `iss no corresponde a este Tourniquet`. Arreglado reconociendo el token propio
   **primero**, con `ISS_PROPIO` como constante compartida con los `signOptions` del módulo.
3. **El validador exigía las `TQ_*` en el constructor.** Rompía `AUTH_MODO=local`, que es
   justamente el modo que tiene que funcionar sin Tourniquet. Ahora construye siempre (el guard
   global lo necesita inyectado) y avisa por `warn` si falta config; el error aparece solo cuando se
   intenta usar de verdad el IdP.
4. **`ValidadorTourniquet` no resolvía dependencias.** El `APP_GUARD` se instancia en el módulo
   raíz y no ve los providers de `AuthModule`. Se resolvió con un módulo `@Global()` propio en vez
   de reexportar el provider a mano.

### Lo que falta (fuera de esta fase)

- **Refresh silencioso y logout de app** contra `/oidc/revoke`. El canje y el ingreso están cerrados;
  la renovación de sesión y el logout、de un lado de Tourniquet quedan para una fase siguiente.
- **Rotar las credenciales** que se usaron para las pruebas: quedaron expuestas en el chat de trabajo.
- Aplicar `57-user-per-idp-sub.sql` y vincular `idp_sub` en las bases de los demás clientes.

### La decisión del `state`: cookie `HttpOnly`, no tabla

Validar el `state` contra algo guardado **exige** un lugar donde RHPro lo guarde, y ahí estuvo la
decisión de la fase:

- **`sessionStorage`, validado por el front:** se descartó. El backend nunca sabría si es legítimo, y
  entonces un atacante podría POSTearle a `/auth/exchange` un `code` suyo con su `code_verifier` y
  dejarle **la sesión de él** en el navegador de la víctima. Es *login CSRF*: no le roba nada a la
  víctima, pero la mete adentro de la cuenta del atacante.
- **Cookie `HttpOnly` + comparación en el backend:** es lo que se implementó. El front ni lee ni
  altera el `state`; solo el backend decide, y lo borra al canjear. No deja estado en el servidor
  (sobrevive a un reinicio) y no necesita tabla nueva.

El `state` es `randomBytes(32)` en base64url (256 bits) en una cookie de 10 minutos, y la comparación
es con `timingSafeEqual`. Un `===` filtraría por el tiempo cuanto se acercó a acertar, y este valor
decide si el canje vale.

**El `code_challenge` lo genera el browser, no el backend.** Son dos caminos distintos: el `state` lo
emite el backend (que es quien puede guardarlo en la cookie) y el challenge lo genera el front con
`crypto.subtle`. Si el backend generara el challenge, tendría que acordarse del verifier para poder
canjear después, que es estado nuevo que expirar y limpiar. El verifier vive en `sessionStorage`
—no `localStorage`— porque es de un solo intento.

### Bugs que aparecieron en la prueba de navegador

1. **No hay `cookie-parser` en RHPro.** La app parsea el header `Cookie` a mano
   (`static-auth.middleware.ts` lo hace así). Leer `req.cookies` daba `undefined` siempre, y *todo*
   canje moría con "No hay un inicio de sesión que validar". Se agregó `leerCookie()` en
   `inicio-oidc.service.ts`, siguiendo el camino que ya usaba el repo en vez de inventar uno nuevo.
2. **`export const dynamic = 'force-static'` vaciaba los request headers.** El front es
   `output: "export"`, y Next exige esa configuración en los route handlers `GET`; al aplicarla, en
   `next dev` el handler recibía **todos** los headers vacíos (`cookie`, `content-type`, `referer`),
   aunque el body sí llegara. Instrumentar el handler fue lo que lo destapó. Se resolvió
   pasando el inicio de login a **`POST`**: (a) es lo correcto, porque iniciar login *crea* la cookie
   del `state` y un `GET` que escribe estado se puede disparar con un prefetch; y (b) los route
   handlers `POST` no disparan el chequeo de estatismo, que es lo que rompía el build.
3. **El front de Tourniquet resolvía el `returnTo` contra su propio origen.** El backend devuelve el
   destino **relativo al issuer** (`/oidc/authorize?...`, ver `backend/src/auth/return-to.ts`, que
   solo acepta paths bajo `<issuer>/oidc/authorize`), pero el login del portal hacía
   `router.replace(destino)`, y Next lo resolvía contra `:3002` en vez de `:3001`: terminaba en
   `http://localhost:3002/oidc/authorize/` y daba 404. Ahora navega a `API_URL + destino` con
   `location.assign`, que es una navegación de verdad por ser otro origen.

### Una nota sobre el resultado de las pruebas

Un caso se dio por bueno dos veces y era falso: el rechazo de `state` falso. La cookie no estaba
presente, así que el 401 venía de la rama de "no hay cookie" y no de la de "state no coincide". La
prueba que sí vale es con **cookie válida + state falso**, que da un mensaje distinto
("El inicio de sesión no coincide"). Los tres motivos se distinguen, lo cual confirma que cada
control dispara por su cuenta: `state` ausente, `state` que no calza, y PKCE rechazado.
