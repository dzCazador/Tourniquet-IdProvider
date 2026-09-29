# Fase 00 — Login local real contra `user_per` (repo RHPro)

**Estado:** ⬜ Pendiente
**Depende de:** nada
**Repo:** `D:\Programacion\Nest\RHPro-NextGeneration` (**no** es este repo)
**Requiere acción del usuario:** **sí** — correr un `.sql` de DDL/DML en la base de negocio
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

- [ ] Login y logout funcionando con al menos dos usuarios reales de `rhpro_marcelino` (uno con
      permisos, uno sin acceso a ningún módulo: el segundo debe ver el menú vacío, no un error).
- [ ] 5 intentos fallidos consecutivos ⇒ bloqueo 15 min; auditado en el log.
- [ ] Contraseña guardada como hash argon2id/bcrypt; **cero** contraseñas en claro en la base
      después de la migración.
- [ ] El `.env` sin `AUTH_PASSWORD` en claro una vez migrado (o con el password vacío y la variable
      de emergencia activa, según decida el usuario).
- [ ] La forma de `UserSession` es idéntica a la de hoy: mismos campos (`usuario`, `nombre`,
      `perfil`, `base`), mismos tipos. `auth-context.tsx` sin cambios.
- [ ] `perfil` sigue saliendo de `perf_usr` de la base activa (mismo SQL de siempre).
- [ ] `npm run lint` verde en backend y frontend.
- [ ] El usuario de emergencia por `.env` funciona y cada uso deja log explícito.

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
