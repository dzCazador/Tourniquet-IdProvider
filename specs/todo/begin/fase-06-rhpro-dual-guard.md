# Fase 06 — RHPro como relying party: guard dual, exchange e `idp_sub`

**Estado:** ⬜ Pendiente
**Depende de:** [05](fase-05-registro-demo.md)
**Repo:** `D:\Programacion\Nest\RHPro-NextGeneration` (**no** es este repo)
**Requiere acción del usuario:** **sí** — DDL en la base de negocio + alta de `idp_sub`
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

### 6. `/auth/exchange`

Backend de RHPro:

1. Verifica `code` + `verifier` contra `code_challenge` (el code ya lo validó Tourniquet; el
   verificador lo manda el front).
2. `POST` a `{TQ_ISSUER}/oidc/token` con `grant_type=authorization_code`, `client_id`,
   `redirect_uri` **igual** al registrado, `code`, `code_verifier`.
3. Verifica el access recibido (mismo validador del punto 4: nunca confíes en la respuesta de otro
   servicio por estar en la red interna).
4. Traduce `sub` → `idusuario` interno de RHPro vía `user_per.idp_sub`.
5. Firma la **cookie de sesión propia** de RHPro (la que hoy entiende `auth-context.tsx`) y la
   devuelve. El refresh queda `HttpOnly` en el **dominio de RHPro**, no en el del IdP
   (`specs/01` §4).

El access de Tourniquet **no** viaja al browser de RHPro: vive en memoria del backend y en la
cookie propia transformada. SiRHPro necesitara el token del IdP para llamar a otra API, es un
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

- [ ] Con `AUTH_MODO=dual`, RHPro acepta **ambos** orígenes: login local (cookie propia) y token de
      Tourniquet.
- [ ] Con `AUTH_MODO=local`, un token de Tourniquet válido da 401. Con `AUTH_MODO=idp`, el token
      local da 401.
- [ ] Token con `aud` distinto de `TQ_AUDIENCE` ⇒ 401. Token con `tenant` distinto de
      `TQ_TENANT` ⇒ 401. (Probar los dos casos con tokens emitidos legítimamente y reescritos en la
      fase de prueba: se generan con un script de desarrollo, nunca en producción.)
- [ ] Usuario que existe en Tourniquet **sin** fila en `user_per` ⇒ 401 "usuario no habilitado". No
      se crea el operador solo.
- [ ] Menú, perfiles y permisos de RHPro **sin cambios observables** respecto de la Fase 00: mismo
      comportamiento con la sesión originada en el portal.
- [ ] El perfil sigue saliendo de `perf_usr` de la base activa, no del token.
- [ ] Login completo desde el portal: 302 a RHPro, callback, cookie propia, landing en el inicio.
- [ ] **Callback sin `state` válido ⇒ el login se rechaza** (no se acepta el code).
- [ ] Logout de app: la sesión de RHPro muere, la sesión central **sigue viva** (el usuario puede
      entrar a otra app sin re-loguearse). "Salir de todo" (Fase 07) apaga las dos.
- [ ] Refresh de RHPro renueva el access propio sin pedirle nada al usuario; con refresh vencido o
      sesión cerrada ⇒ cierre de sesión y redirect al portal.
- [ ] `POST /auth/rotate-jwks` rompe la caché: tras un `kid` nuevo en el JWKS, el siguiente request
      con ese token valida sin reiniciar el proceso.
- [ ] Un token con `alg=none` y uno con HS256 (firmado con un secreto inventado) ⇒ 401 en los tres
      modos.
- [ ] Con Tourniquet **caído** (backend apagado) y `AUTH_MODO=dual`, el login local de RHPro sigue
      funcionando: es D5 verificado, no supuesto.
- [ ] `npm run lint` y `npm run build` verdes en RHPro (backend y frontend).
- [ ] El DDL de `idp_sub` tiene su variante `.mysql.sql` y su reversión (política del repo RHPro).

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
