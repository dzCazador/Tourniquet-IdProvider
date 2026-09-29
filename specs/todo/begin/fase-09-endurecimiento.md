# Fase 09 — Endurecimiento: MFA, rotación de claves, jobs y export de registro

**Estado:** ⬜ Pendiente
**Depende de:** [08](fase-08-admin-identidad.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** **sí** — crear el job de SQL Agent, generar `TQ_MASTER_KEY` del
gestor de secretos, ejecutar el drill de rotación
**Riesgo:** medio — MFA y rotación tocan el camino de login y la firma de tokens
**Reversible:** MFA se puede desactivar por usuario; la rotación no tiene vuelta atrás para los
tokens ya emitidos (que expiran solos en 15 min)
**Spec normativo:** `specs/01-tokenos-y-seguridad.md` §5, §7, §8; `specs/04-fases.md` Fase 04
**Mapa:** `specs/04-fases.md` Fase 04

---

## Por qué esta fase es "lo que el primer contrato real pida"

`specs/04` Fase 04 lo dice: se entrega lo que el primer contrato pida y **todo lo demás queda
documentado como no hecho**. Esta fase agrupa cuatro ítems que comparten una característica: son
operaciones que no afectan la vida diaria del usuario pero cuya ausencia se nota en el peor
momento, y que son las que un cliente enterprise pregunta en el questionnaire de seguridad.

Ninguno bloquea al siguiente. Si un contrato pide sólo MFA, se entrega MFA y el resto queda
listado como pendiente, no como supuesto.

---

## Objetivo

Los cuatro ítems de `specs/04` Fase 04, cada uno con su runbook, con lo no entregado explícito.

---

## 9.1 — MFA TOTP

**Diseño cerrado en `specs/01` §8**: TOTP RFC 6238, SHA-1, 30 s, 6 dígitos, ventana ±1, códigos de
recuperación de un solo uso, `mfa_secret` cifrado con AES-256-GCM.

Trabajo:

1. `mfa.service.ts`: `activar(usuario)` devuelve `otpauth://` (con `issuer=Tourniquet`, `account=usuario`);
   `verificar(usuario, codigo)` con ventana ±1 y tolerancia de reloj medida; `usar_codigo_recuperacion`.
2. Estados: `off → pending → on`. En `pending`, `mfa_secret_cifrada` ya está poblado pero el
   challenge no se pide todavía. Es lo que permite enrolar sin cortar el acceso.
3. Login (`POST /auth/login`): si `mfa_estado='on'`, responde `{ requiere_mfa: true, factor_id }` y
   **no** crea sesión. Un segundo endpoint (`POST /auth/mfa/verify`) completa el login con el
   código. La sesión se crea recién ahí.
4. `amr` pasa a `["pwd","mfa"]` en el access token. La app que quiera leerlo ya lo tiene
   (`specs/01` §8), sin cambios de esquema.
5. Códigos de recuperación: 10 por usuario, hasheados (sha256), de un solo uso, mostrados una vez
   en la pantalla de enrolamiento. Se pueden regenerar desde el panel admin (§9.5).
6. Front: pantalla de verificación con 6 dígitos, `inputMode="numeric"`,
   `autocomplete="one-time-code"`, letras de 28 px, **nivel de tema bajo** (`estetica-tourniquet.md`
   §2). Con el tema fuerte, un campo de 6 dígitos es ilegible y frustrante.
7. Panel: activar/desactivar MFA por usuario, regenerar códigos de recuperación.

**Criterios:** MFA activado exige el código; MFA pendiente no; un código usado dos veces falla;
un código de hace 3 períodos falla; `amr` trae `mfa`; la clave del secret nunca sale del backend;
quedan 2 códigos ⇒ aviso en la UI; desactivar MFA pide confirmación fuerte y queda auditado.

## 9.2 — Rotación de claves de firma

**Procedimiento de `specs/01` §5**: RSA 2048, `kid` = hash corto de la pública, rotación cada 90 días
o por compromiso. Proceso: generar nueva → publicar en JWKS (coexiste) → firmar con la nueva →
retirar la anterior 24 h después.

Trabajo:

1. `POST /admin/claves/rotar`: genera la nueva, la activa, deja la anterior con `retirada_en = now`.
   Sólo `admin_identidad` del tenant... **no**: la rotación de claves de firma es **global** para la
   instalación, no por tenant (el JWKS es único). Se protege distinto: requiere un rol nuevo a nivel
   de instalación, o una lista de `operadores` en la configuración. **Decidir en esta fase y
   anotarlo en el spec.** Mientras tanto, el endpoint se habilita por variable de entorno
   (`TQ_ROTATION_HABILITADA=false` por default) y el procedimiento es manual por script.
2. `scripts/rotar-clave.mjs` para el caso manual, que es el que va al runbook.
3. `deploy/runbooks/rotacion-claves.md`: pasos, ventana, verificación y rollback.
4. Job de verificación: un script que dice "hay N tokens firmados con kids que ya no están en el
   JWKS".

**Criterios:** tras rotar, los tokens viejos siguen validando 15 min; tras 24 h dejan de estar en el
JWKS; los tokens nuevos usan el `kid` nuevo; el drill completo se ejecutó **una vez real** y quedó
registrado; el rollback (reactivar la clave anterior) funciona si el drill falla a mitad.

## 9.3 — Jobs de limpieza (SQL Agent, los ejecuta el usuario)

`specs/01` §7: la retención y la limpieza se hacen **por job externo a la app**, nunca con `DELETE`
desde código de negocio.

| Job | Qué | Frecuencia | `deploy/sql/` |
|---|---|---|---|
| `90-job-codigos.sql` | `DELETE tok_autorization_code WHERE expira_en < now - 1 día` | cada 5 min | `95-job-codigos.sql` |
| `91-job-refresh.sql` | `DELETE tok_refresh_token WHERE revocado_en < now - 90 días` (los expirados se conservan mientras la sesión viva) | diaria | `96-job-refresh.sql` |
| `92-job-auditoria.sql` | `DELETE aud_login WHERE ts < DATEADD(year, -2, now)` | mensual | `97-job-auditoria.sql` |
| `93-job-sesiones.sql` | Marca `cerrada_en`/`motivo='expirada'` en sesiones vencidas (no borra) | cada hora | `98-job-sesiones.sql` |

Cada `.sql` con su `SELECT` de conteo previo y posterior. Los **crea y los agenda el usuario** en
SQL Agent; el agente entrega los scripts. El job de auditoría nunca borra filas de menos de 2 años
y su retención es 2 años "o el contrato del cliente" (`specs/01` §7): si un cliente pide 5 años,
cambia el script y el spec, no el criterio.

**Criterios:** con un code vencido de hace 2 días, el job lo elimina; un code de hace 1 hora, no;
el job de auditoría respeta los 2 años; correr los jobs dos veces no rompe nada; **ningún endpoint
de la app borra** auditoría.

## 9.4 — Export para el futuro TenantRegistry de RHPro

`specs/04` Fase 04 pide "interfaz de export para el futuro TenantRegistry de RHPro
(`/registry/bases/:tenant` con inventario; el desencripto de credenciales por mecanismo separado,
**sin diseño**)".

- `GET /registry/bases/:tenant` **ya existe** desde la Fase 05 (inventario, sin credenciales). Se
  consolida acá: se le agrega `GET /registry/aplicaciones/:tenant` y se documenta el contrato.
- El **desencripto de credenciales sigue sin diseño.** No se implementa un endpoint que devuelva
  contraseñas de bases de negocio. Cuando el TenantRegistry de RHPro se ejecute, ese mecanismo se
  diseña con su propio spec (probablemente out-of-band: archivo, gestor de secretos, o un
  cliente de servicio a servicio). Queda anotado como pendiente, no como supuesto.

**Criterios:** el contrato está documentado; el admin de un tenant sólo lee su tenant; ningún
campo de la respuesta contiene `usuario` ni credencial.

## 9.5 — Lo que se documenta como **no hecho**

Lista explícita, para que no aparezca como supuesto en un informe:

- △ Federación saliente (AD/Entra del cliente): **no implementado**, requiere spec propio y
  aprobación (D1 de `specs/00`).
- △ Auto-provisioning de `user_per` en RHPro: **no implementado** (`specs/00` §7).
- △ Cliente `confidential` con `client_secret`: **no implementado** (`specs/01` §1).
- △ Recuperación de la master key: **imposible por diseño**. El runbook dice qué hacer si se pierde.
- △ Email de recuperación / verificación: **no implementado**. El alta es del admin.
- △ Cambio de contraseña por el usuario: **no implementado**.
- △ Logs centralizados / SIEM: **no implementado**; `aud_login` es la fuente.
- △ Rate limit distribuido: **no implementado** (en memoria, una instancia por instalación, D3).

---

## Criterios de aceptación de la fase

- [ ] MFA: activar, enrolar, verificar, desactivar. Un login con `mfa_estado='on'` sin código no
      crea sesión.
- [ ] `amr` = `["pwd","mfa"]` con MFA activo, `["pwd"]` sin él.
- [ ] El secret cifrado de `idn_usuario.mfa_secret_cifrada` es binario y no sale por ningún
      endpoint (probado con el listado de usuarios del panel: el campo no está).
- [ ] Códigos de recuperación: 10, de un solo uso, mostrados una vez; regenerar invalida los
      anteriores.
- [ ] Rotación: drill ejecutado **una vez real**, con los 5 pasos del runbook anotados con
      resultado. Tokens viejos válidos 15 min; nuevos con `kid` nuevo.
- [ ] JWKS sirve activa + retiradas dentro de 24 h; fuera de 24 h, no.
- [ ] Los 4 jobs están creados y agendados **por el usuario**; correrlos dos veces es inofensivo.
- [ ] `aud_login` conserva 2 años y ningún endpoint la borra.
- [ ] `/registry/bases/:tenant` y `/registry/aplicaciones/:tenant` responden sólo al admin del
      tenant y sin credenciales.
- [ ] La lista de "no hecho" (§9.5) está en el README del repo y en el informe de instalación.
- [ ] `npm run lint` verde.

---

## Seguridad

| Invariante | Aplicación |
|---|---|
| `mfa_secret` cifrada, nunca en claro | AES-256-GCM con `TQ_MASTER_KEY`; el `otpauth://` se muestra una vez y el secret no vuelve a salir |
| `amr` refleja lo que pasó | `["pwd"]` o `["pwd","mfa"]`. Nunca `mfa` sin que se haya verificado el segundo factor |
| Rotación de claves = operación sensible | Deshabilitada por env por default; requiere rol de instalación (a decidir); auditada |
| La app nunca borra auditoría | Los 4 jobs son SQL del usuario, fuera de la app |
| Sin endpoint de credenciales | `cat_base_datos.credencial_cifrada` no sale por API, en ninguna fase, incluida esta |
| Master key fuera de todo | Se genera, se guarda en el gestor de secretos del cliente y **nunca** entra a un backup de la base |

## Trampas

1. **La ventana ±1 de TOTP es generosa y también es la ventana de reuso.** Con ventana ±1, un
   código válido en el período N también lo es en N+1. Guardar el **último período aceptado** y
   rechazar reutilizarlo evita que un código espiado en el límite sirva dos veces.
2. **MFA en `pending` que pide el código igual.** Si `mfa_estado='pending'` pide el factor, el
   usuario queda sin acceso entre el alta y la confirmación. En `pending` no se pide nada.
3. **Rotar y no verificar.** El drill tiene que terminar con un login **real** contra una app
   configurada con el `TQ_ISSUER` nuevo. Una rotación que nadie probó es una rotación que se
   descubre durante un incidente.
4. **El JWKS sin la ventana de solapamiento.** Retirar la clave vieja de inmediato invalida tokens
   en vuelo de otras máquinas con reloj desincronizado. Son 24 h por algo (`specs/01` §5).
5. **Job de auditoría con la retención mal medida.** `DATEADD(year, -2, getdate())` en un job que
   corre el 29 de febrero puede dejar filas con 2 años exactos en el borde. Se mide con
   `< DATEADD(year,-2,...)` y se acepta la diferencia de un día: preferible dejar de más que borrar
   de más.
6. **"Salir de todo" y MFA en el medio.** Con MFA activo, cerrar sesión requiere sólo el click
   (no el código). El MFA protege el ingreso, no el egreso. Quien quiera proteger el egreso necesita
   un segundo factor al cerrar, que **no** está en `specs/01` §8 y sería un cambio de spec.
