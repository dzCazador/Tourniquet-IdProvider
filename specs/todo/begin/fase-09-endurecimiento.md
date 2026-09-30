# Fase 09 — Endurecimiento: MFA, rotación de claves, jobs y export de registro

**Estado:** ✅ Código cerrado y verificado · ⏳ **[browser]** y drill de rotación pendientes
**Depende de:** [08](fase-08-admin-identidad.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** **sí** — aplicar `03-mfa-segundo-factor.sql` en producción,
**agendar los 4 jobs**, generar `TQ_MASTER_KEY` del gestor de secretos y ejecutar el drill de rotación
**Riesgo:** medio — MFA y rotación tocan el camino de login y la firma de tokens
**Reversible:** MFA se puede desactivar por usuario; la rotación no tiene vuelta atrás para los
tokens ya emitidos (que expiran solos en 15 min)
**Spec normativo:** `specs/01-tokenos-y-seguridad.md` §5, §5.1, §7.1, §8; `specs/04-fases.md` Fase 04
**Mapa:** `specs/04-fases.md` Fase 04

---

## Verificado en esta fase

| Qué | Cómo | Resultado |
|---|---|---|
| Algoritmo TOTP | `npm run verificar:mfa` contra los **6 vectores del apéndice B del RFC 6238** | ✅ TODO OK (33 comprobaciones) |
| Flujo completo de MFA, panel, export y rotación apagada | `npm run verificar:portal` | ✅ TODO OK (**135 comprobaciones**; 40 de la 09) |
| Esquema: caminos (A) y (B) | `00-crear-base.sql` (idempotente) sobre la base del camino (B) + `99-verificar-esquema.sql` antes y después | ✅ **cero diferencias** |
| Los 4 jobs | Aplicados con `npm run sql:dev` sobre `tourniquet_dev` | ✅ los 4 corren; `98` cerró 1 sesión vencida con `motivo='expirada'` |
| Rotación (estado y verificación) | `npm run rotar:clave` y `npm run verificar:rotacion` | ✅ TODO OK |
| Lint y tipos | `npm run lint` + `tsc --noEmit` en backend y frontend | ✅ 0 errores (7 warnings preexistentes) |

**Lo que queda sin verificar**, y es importante que quede escrito:

- **[browser]** La pantalla `/mfa` (6 dígitos, `inputMode`, `one-time-code`, foco), el bloque
  de `/mi-cuenta` y las tres acciones del panel: nada de eso se puede comprobar con `fetch`.
  Los criterios son los de `estetica-tourniquet.md` §7 y §9 (teclado, 360 px, `axe`).
- **El drill de rotación real** (5 pasos del runbook contra un `TQ_ISSUER` de cliente). En
  desarrollo el procedimiento no se puede correr entero porque no hay una app consumiendo el
  issuer, que es justamente el paso 4. Queda escrito en `deploy/runbooks/rotacion-claves.md`.

---

## Decisiones que tomó esta fase

Ninguna de estas estaba cerrada en el borrador; las cuatro están anotadas en el spec
**antes** de escribir el código (regla 2 del protocolo del agente).

### 9.0.a Quién puede rotar las claves

**Lista de operadores en la configuración + endpoint apagado por default**
(`TQ_ROTACION_HABILITADA=false`, `TQ_OPERADORES_CLAVES=admin,...`, con sesión de portal
viva). Descartado un rol nuevo en `idn_usuario_cliente.rol`: ese rol es **por cliente** y la
rotación es **de la instalación** (el JWKS es único), así que un `admin_identidad` de `cervi`
terminaba pudiendo romper el login de `jugos`. Ver `specs/01` §5.1.

### 9.0.b La ruta del endpoint de rotación

**`POST /operacion/claves/rotar`**, no `/admin/claves/rotar` como decía el borrador. En todo el
repo `/admin/*` significa "panel de un cliente" y ya tiene un guard con otro sentido; un
prefijo propio hace que la confusión entre "panel de un tenant" y "rotar las claves de la
instalación" no sea ni siquiera escribible.

### 9.0.c Desactivar MFA y las sesiones vivas

**Se cierran**, en ese cliente. Sin eso, el token de una sesión vieja seguiría afirmando
`amr: ["pwd","mfa"]` mientras la cuenta ya no lo exige, y valdría lo mismo que una
contraseña. `specs/01` §8.4.

### 9.0.d Los jobs en un motor sin SQL Agent

**SQL Server Express no tiene SQL Agent**, y es un motor razonable para una instalación de
cliente. Los cuatro `.sql` son T-SQL puro, idempotentes y sin `USE`, así que se agendan de
las dos maneras: SQL Agent si el motor es completo, y **Planificador de tareas de Windows +
`deploy/jobs/ejecutar-jobs.cmd`** (que invoca `sqlcmd`) si es Express. La cuenta que los
corre no necesita `TQ_MASTER_KEY`. `deploy/runbooks/jobs-limpieza.md` tiene el procedimiento.

---

## Desviaciones del borrador, y por qué

| El borrador decía | Se hizo | Por qué |
|---|---|---|
| Un job `96-` para cada tabla (5 archivos) | `95-` borra también `tok_mfa_challenge` | Es la única tabla que crece con cada login, y el rango de limpieza es el mismo. Sumar un `96-` que el operador tiene que recordar crear es peor que un job menos |
| Un "job que dice cuántos tokens firmados con kids fuera del JWKS" | `npm run verificar:rotacion` reporta la **cota** por fecha, y con `--token` valida un token real | **No se puede contar**: los access tokens no se persisten (invariante de `AGENTS.md`), así que no hay `COUNT` que hacer. Lo que sí es cierto es que a los 15 min de la retirada no queda ninguno vivo |
| Un QR en el diálogo del panel | Se muestra la **clave en base32** + la URI `otpauth://`, con botón de copiar | Un encoder de QR son ~200 líneas de álgebra de campos para un caso de uso que ocurre **una vez por enrolamiento**, y donde casi todas las apps de autenticación tienen "ingresar clave manualmente". El costo de un QR mal generado es un usuario enrolado con el secret equivocado |
| El panel activa MFA **o** el usuario | El panel activa (`pending`); el usuario **confirma** desde `/mi-cuenta` | El `otpauth://` y los 10 códigos salen en una sola respuesta. Que el usuario lo active desde el navegador es el escenario de un atacante con la clave ajena: se lleva el secret y los códigos |

---

## Lo que este archivo **no** encontró, pero la corrida de los SQL sí

Dos defectos de herramientas de verificación que hacía tiempo que estaban y que sólo
aparecen cuando las corrés de verdad:

1. **`99-verificar-esquema.sql` nunca había corrido.** Filtraba sólo `cat_*` (una tabla o columna
   de `idn_`/`tok_`/`aud_` pasaba la comparación sin aparecer en la huella) y usaba
   `sys.foreign_keys.referenced_column_id`, que no resuelve en **SQL Server 2022** (Msg 207).
   Corregido: los cuatro prefijos, y la columna referida sale de `sys.foreign_key_columns`.
2. **El `@@ROWCOUNT` del job 97** hacía un `WHILE` infinito: cualquier sentencia entre el
   `DELETE` y el `IF @@ROWCOUNT = 0` lo vuelve a poner en cero, así que el corte nunca se veía.
   No rompía datos (borraba cero filas en loop), pero quemaba una conexión y un CPU del
   servidor para siempre, y en una tarea programada eso es un incidente que nadie entiende.
   El patrón correcto copia el `@@ROWCOUNT` a una variable primero.

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

**Diseño cerrado en `specs/01` §8**, y detallado en §8.1 a §8.6.

Trabajo (hecho):

1. ✅ `backend/src/auth/totp.ts`: TOTP RFC 6238 (SHA-1, 30 s, 6 dígitos, ventana ±1) y base32
   RFC 4648, **implementados en el repo y sin dependencia nueva**. Se comprueban contra los
   6 vectores del apéndice B del RFC con `npm run verificar:mfa`, que es la única forma de
   saber que el algoritmo sirve sin una app de autenticación real. `activar` devuelve el
   `otpauth://` con `issuer=Tourniquet`; `verificar` guarda el **período** aceptado; y
   `usar_codigo_recuperacion` marca la fila.
2. ✅ Estados `off → pending → on`. En `pending` el secret está poblado y **no** se pide nada:
   el ingreso sigue siendo de un paso.
3. ✅ `POST /auth/login` responde `{ requiere_mfa: true, factor_id, ... }` y **no** crea
   sesión; `POST /auth/mfa/verify` es el que la crea. La fila de `tok_mfa_challenge` guarda el
   usuario, el cliente y el `returnTo` **ya resueltos**, así que el segundo paso no confía en
   nada del cliente.
4. ✅ `amr` pasa a `pwd,mfa` en la sesión de portal y de ahí al token de cada app.
   `AMR_SOLO_CLAVE`/`AMR_CON_MFA` son constantes en `oidc/sesion.service.ts`.
5. ✅ 10 códigos de recuperación hasheados con sal por usuario, de un solo uso, mostrados una
   vez; se regeneran desde el panel y eso invalida los anteriores.
6. ✅ Front: `/mfa` con campo de 6 dígitos a 28 px, `inputMode="numeric"`,
   `autocomplete="one-time-code"`, tema bajo, y un enlace para usar un código de recuperación.
7. ✅ Panel: activar (devuelve el `otpauth` + los 10 códigos una vez), desactivar (con
   confirmación fuerte, y cierra las sesiones del cliente) y regenerar códigos.
   En `/mi-cuenta`: confirmar el `pending` y desactivar el propio.

**Criterios:** todos verificados por HTTP en `npm run verificar:portal` (40 comprobaciones de
esta fase). MFA activado exige el código; MFA pendiente no; un código usado dos veces falla; un
código de hace 3 períodos falla; `amr` trae `mfa`; el secret cifrado es binario y no sale por
ningún endpoint (comprobado en la respuesta del panel y en el listado de usuarios); quedan 2
códigos ⇒ aviso en la UI; desactivar pide confirmación fuerte y queda auditado.

## 9.2 — Rotación de claves de firma

**Procedimiento de `specs/01` §5**, y las decisiones de quién y por dónde en **§5.1**.

Trabajo (hecho):

1. ✅ `POST /operacion/claves/rotar` genera la nueva, la activa y deja la anterior con
   `retirada_en = now`. **Apagado por default** (`TQ_ROTACION_HABILITADA=false` ⇒ 404) y con
   lista de operadores de instalación (`TQ_OPERADORES_CLAVES`). La ruta NO es `/admin/...`:
   ver las decisiones de esta fase.
2. ✅ `npm run rotar:clave` (`--rotar`, `--reactivar <kid>`, `--si`) es el procedimiento del
   runbook, con confirmación escrita.
3. ✅ `deploy/runbooks/rotacion-claves.md`: los 5 pasos, la ventana, la verificación y el
   rollback, más el caso urgente de clave comprometida.
4. ✅ `npm run verificar:rotacion` con `--token`: estado de las claves, ventana de 24 h y, si se
   le pasa un access token real, con qué `kid` se firmó, si sigue publicado y cuánto le queda.
   **No cuenta tokens** y el archivo explica por qué: no se persisten.
5. ✅ `FirmaService.reactivar(kid)`: el rollback usa el `kid` anterior, no una clave nueva.

**Criterios:** el drill de rotación **real, de punta a punta, queda pendiente** (necesita un
`TQ_ISSUER` de cliente y una app consumiendo el issuer). Lo verificado: tokens viejos validan
durante la ventana, el `kid` nuevo firma, el JWKS publica activa + retiradas dentro de 24 h y
deja de publicar las viejas, y el rollback se puede ejecutar (`npm run rotar:clave` responde y
`reactivar` está implementado y probado por firma/verificación del servicio).

## 9.3 — Jobs de limpieza (SQL Agent, o Planificador si el motor es Express)

`specs/01` §7 y **§7.1**: la retención y la limpieza se hacen **por job externo a la app**,
nunca con `DELETE` desde código de negocio.

| Job | Qué | Frecuencia | `deploy/sql/` |
|---|---|---|---|
| `95-job-codigos.sql` | `DELETE tok_autorization_code WHERE expira_en < now - 1 día`, y `tok_mfa_challenge` vencidos | cada 5 min | ✅ |
| `96-job-refresh.sql` | `DELETE tok_refresh_token WHERE revocado_en IS NOT NULL AND revocado_en < now - 90 días` | diaria | ✅ |
| `97-job-auditoria.sql` | `DELETE aud_login WHERE ts < DATEADD(year, -2, now)`, por lotes de 5000 | mensual | ✅ |
| `98-job-sesiones.sql` | Marca `cerrada_en`/`motivo='expirada'` en sesiones vencidas (no borra) | cada hora | ✅ |

Cada `.sql` con su `SELECT` de conteo previo y posterior, **y con el "lo que NO se tocó"**: los
tres filtros son `DELETE`/`UPDATE` con `WHERE` de fecha, y un job que empieza a borrar de más se
detecta en la diferencia entre los conteos, no en el total.

**Quién los agenda es del cliente**, y el motor decide cómo: SQL Agent si es SQL Server completo,
**Planificador de tareas de Windows + `deploy/jobs/ejecutar-jobs.cmd`** si es **SQL Server
Express**, que no tiene Agente. Los `.sql` no cambian entre las dos variantes. El procedimiento
paso a paso está en `deploy/runbooks/jobs-limpieza.md` (cuenta de servicio, autenticación
integrada, permisos mínimos, el paso exacto del Planificador y qué hacer si un job falla).

**Criterios:** verificados corriendo los cuatro sobre `tourniquet_dev`. `98` cerró 1 sesión
vencida con `motivo='expirada'` y dejó las cerradas por logout/replay/revocada con su motivo
intacto; `95`, `96` y `97` corrieron con 0 filas que borrar (base de desarrollo con menos de
2 años de historia) y con su verificación en 0. Correrlos dos veces es inofensivo por diseño
(idempotencia), y **ningún endpoint de la app borra** auditoría: `AuditoriaService` no expone
`update` ni `delete`.

## 9.4 — Export para el futuro TenantRegistry de RHPro

`specs/04` Fase 04 pide "interfaz de export para el futuro TenantRegistry de RHPro". Hecho:

- `GET /registry/bases/:tenant` (ya existía desde la Fase 05) **más** el nuevo
  `GET /registry/aplicaciones/:tenant`: las apps del cliente con la base de negocio activa de
  cada una. El contrato y las tres reglas que lo gobiernan están en `specs/00` **§4.2**.
- La autorización es **la misma llamada** en los dos endpoints (`esAdminDeCliente`), a
  propósito: si las apps tuvieran un chequeo distinto, el error del olvido sería el que menos
  se nota.
- El **desencripto de credenciales sigue sin diseño.** No hay ningún endpoint que devuelva
  contraseñas de bases de negocio, en esta fase ni en ninguna otra, y no se va a agregar sin un
  spec propio.

**Criterios:** verificados por HTTP — 200 para el admin del cliente, 403 para el admin de otro,
401 sin sesión, y la respuesta no contiene ninguna clave llamada `usuario`, `host` ni
`credencial*` (la comprobación mira los **nombres de clave**, no el texto: un `/host/i` sobre el
JSON marca "localhost" dentro de `url_inicio` y da un falso positivo).

## 9.5 — Lo que se documenta como **no hecho**

La lista vive ahora en el **`README.md` de la raíz**, en dos tablas: la de "no implementado"
(federación saliente, auto-provisioning, cliente `confidential`, recuperación de la master key,
email, cambio de contraseña por el usuario, SIEM, rate limit distribuido, desencripto de
credenciales) y la de "con limitación conocida" (MFA, `/operacion/claves`, el conteo de tokens
del `kid`, segundo factor en apps, `prompt`/`max_age`). Está también en el resumen de `specs/04`
Fase 04, que es donde el plan la quería.

---

## Criterios de aceptación de la fase

- [x] MFA: activar, enrolar, verificar, desactivar. Un login con `mfa_estado='on'` sin código no
      crea sesión. **Verificado por HTTP.**
- [x] `amr` = `["pwd","mfa"]` con MFA activo, `["pwd"]` sin él. **Verificado en la base.**
- [x] El secret cifrado de `idn_usuario.mfa_secret_cifrada` es binario y no sale por ningún
      endpoint (probado con el listado de usuarios del panel: el campo no está). **Verificado.**
- [x] Códigos de recuperación: 10, de un solo uso, mostrados una vez; regenerar invalida los
      anteriores. **Verificado por HTTP y en la base.**
- [ ] Rotación: drill ejecutado **una vez real**, con los 5 pasos del runbook anotados con
      resultado. Tokens viejos válidos 15 min; nuevos con `kid` nuevo. **Pendiente: necesita un
      `TQ_ISSUER` de cliente con una app consumiéndolo (paso 4 del drill).**
- [x] JWKS sirve activa + retiradas dentro de 24 h; fuera de 24 h, no. **Verificado con
      `npm run verificar:rotacion`.**
- [ ] Los 4 jobs están creados y agendados **por el usuario**; correrlos dos veces es inofensivo.
      **Los 4 scripts existen y corren (verificado); agendarlos es del usuario** →
      `deploy/runbooks/jobs-limpieza.md`.
- [x] `aud_login` conserva 2 años y ningún endpoint la borra. **Verificado.**
- [x] `/registry/bases/:tenant` y `/registry/aplicaciones/:tenant` responden sólo al admin del
      tenant y sin credenciales. **Verificado por HTTP.**
- [x] La lista de "no hecho" (§9.5) está en el README del repo y en el resumen de `specs/04`. **Hecho.**
- [x] `npm run lint` verde. **Hecho: 0 errores en backend y frontend.**
- [ ] **[browser]** El pase de navegador de `/mfa`, del bloque de `/mi-cuenta` y de las acciones
      del panel: teclado, foco, 360 px, `axe`, `prefers-reduced-motion` (`estetica-tourniquet.md`
      §9). No se puede comprobar con `fetch`.

## SQL

**Los ejecuta el usuario, en producción:**

```bash
sqlcmd -S <srv> -d tourniquet -i deploy/sql/03-mfa-segundo-factor.sql
```

Los cuatro jobs **se agendan**, no se corren a mano: `deploy/runbooks/jobs-limpieza.md`.

## Seguridad

| Invariante | Aplicación |
|---|---|
| `mfa_secret` cifrada, nunca en claro | AES-256-GCM con `TQ_MASTER_KEY`; el `otpauth://` se muestra una vez y el secret no vuelve a salir |
| `amr` refleja lo que pasó | `["pwd"]` o `["pwd","mfa"]`. Nunca `mfa` sin que se haya verificado el segundo factor. El `amr` de la sesión de portal se copia al de cada app, así que tampoco se puede inventar desde la app |
| El `tenant` y el `returnTo` del segundo paso | Salen de la fila de `tok_mfa_challenge`, escrita por el backend. El pedido 2 no recibe usuario, cliente ni destino |
| Anti-reuso del código TOTP | `mfa_ultimo_periodo` + `UPDATE` condicionado: un código no se acepta dos veces, ni con dos peticiones concurrentes |
| Un código de recuperación es de un solo uso | `UPDATE ... WHERE usado_en IS NULL`; el `count: 0` es la carrera perdida |
| Los códigos se hashean con sal por usuario | `sha256(codigo + idusuario)`: sin sal, ~48 bits son un ataque por diccionario con una GPU |
| Rotación de claves = operación sensible | Deshabilitada por env por default; requiere rol de instalación (lista de operadores) y sesión viva; auditada con el `idusuario` del operador |
| La app nunca borra auditoría | Los 4 jobs son SQL del usuario, fuera de la app; `AuditoriaService` no expone `update` ni `delete` |
| Sin endpoint de credenciales | `cat_base_datos.credencial_cifrada` no sale por API, en ninguna fase, incluida esta; y el *tipos* de la respuesta del registro ni siquiera declara el campo |
| Master key fuera de todo | Se genera, se guarda en el gestor de secretos del cliente y **nunca** entra a un backup de la base. La cuenta que corre los jobs **no la necesita** |

## Trampas

1. **La ventana ±1 de TOTP es generosa y también es la ventana de reuso.** Con ventana ±1, un
   código válido en el período N también lo es en N+1. Guardar el **último período aceptado** y
   rechazar reutilizarlo evita que un código espiado en el límite sirva dos veces.
2. **MFA en `pending` que pide el código igual.** Si `pending` pidiera el factor, un usuario al
   que el admin le activa MFA mientras está en medio de un ingreso se quedaría sin acceso entre
   el alta y la confirmación. En `pending` no se pide nada.
3. **Rotar y no verificar.** El drill tiene que terminar con un login **real** contra una app
   configurada con el `TQ_ISSUER` nuevo. Una rotación que nadie probó se descubre durante un
   incidente.
4. **El JWKS sin la ventana de solapamiento.** Retirar la clave vieja de inmediato invalida
   tokens en vuelo de otras máquinas con reloj desincronizado. Son 24 h por algo.
5. **Job de auditoría con la retención mal medida.** `DATEADD(year, -2, getdate())` en un job que
   corre el 29 de febrero deja filas con 2 años exactos en el borde. Se mide con
   `< DATEADD(year,-2,...)` y se acepta la diferencia de un día: preferible dejar de más que
   borrar de más.
6. **"Salir de todo" y MFA en el medio.** Con MFA activo, cerrar sesión sigue siendo sólo el
   click. El MFA protege el ingreso, no el egreso.
7. **`@@ROWCOUNT` se resetea con cualquier sentencia.** En el job 97, el patrón
   `SET @total = @total + @@ROWCOUNT` seguido de `IF @@ROWCOUNT = 0 BREAK` hace un loop
   infinito: la sentencia del medio vuelve a poner el contador en cero y el corte nunca se ve.
   **Tropezada al aplicar el script.** Se copia a una variable primero.
8. **La columna "Time" del RFC 6238 son segundos, no el contador.** Los vectores del apéndice B
   con `X=30` dan `contador = floor(t/30)`: T=59 es el contador 1. Pasarlos tal cual produce
   códigos plausibles de 6 dígitos que no coinciden con ninguna app del mundo. Sólo se ve con los
   vectores del RFC encima.
9. **`99-verificar-esquema.sql` nunca había corrido.** Filtraba sólo `cat_*` y usaba
   `sys.foreign_keys.referenced_column_id`, que no resuelve en SQL Server 2022. Un comprobatorio
   que no corre no verifica nada: hay que correrlo, no leerlo.
10. **Un script de verificación no puede depender de la clave de nadie.** La primera versión de
    la sección MFA pedía la clave del admin por prompt. Va contra el admin de **prueba**, con
    clave conocida, `admin_identidad` en el cliente y borrado al final: el script es autónomo y
    de paso prueba que cualquier admin del tenant puede operar MFA.
11. **El anti-reuso muerde al propio script de verificación.** La confirmación de `pending`
    consume el período actual, así que el "código correcto" del paso siguiente es correcto **y**
    reutilizado. La comprobación usa el código del período siguiente, que la ventana acepta.
12. **Comprobar que no hay un campo, por el nombre del campo y no por el texto.** Un `/host/i`
    sobre el JSON de `/registry/aplicaciones` marca "localhost" dentro de `url_inicio` y hace
    fallar la comprobación con un falso positivo, que es peor que no comprobar.
