# 00 — Arquitectura de Tourniquet

Spec normativo de cabecera. Si otro documento contradice a éste, manda éste y el otro se corrige.

## 1. Propósito

Logueo centralizado y registro de plataforma para la suite multi-cliente:

- Cada **cliente** (tenant) tiene N **aplicaciones** (RHPro AR, RHPro Chile, apps futuras).
- El usuario se identifica **una sola vez** contra Tourniquet y entra a cualquier app habilitada
  con sesión corta por app (OIDC), sin volver a tipear contraseña.
- Antecedente exacto: `fuentesAspViejos/lanzador/Lanzador.asp`, que ya seleccionaba
  base+módulo por cliente (Chile era la base 20, no un fork de código).

## 2. Decisiones fundacionales

| # | Decisión | Motivo | Consecuencia |
|---|---|---|---|
| D1 | **IdP propio que habla OIDC estándar** (auth code + PKCE, discovery, JWKS, RS256) | Todas las apps de la casa son propias (Nest/Next), pero la puerta debe quedar abierta a apps de terceros y a SSO corporativo del cliente (AD/Entra) sin rediseño | Las apps se integran por protocolo, no por código compartido; si mañana se adopta Keycloak/Entra como IdP, Tourniquet puede degradar a "front" federado |
| D2 | **Authn en Tourniquet, authz en cada app** | La autorización de RHPro es por base (`user_per`/`perf_usr`/`menumstr.menuaccess`) y no debe duplicarse en un servicio central | Tourniquet emite identidad + pertenencia (tenant/apps); qué ve el usuario lo decide la base activa de la app. Nunca se agregan permisos de negocio al token |
| D3 | **Despliegue Option A: una instancia por app/base** | Instalación en cliente: donde va Chile sólo hay base de Chile. El plan multibase de RHPro (`../RHPro-NextGeneration/specs/todo/multibase/`) sigue siendo diseño | Tourniquet no abre conexiones a bases ajenas en runtime: `base_datos` es **registro** (inventario/datos de conexión que consume la app o el deploy), no un pool multi-tenant del IdP |
| D4 | **La base de control es de Tourniquet** | `RHPro_Control` del plan multibase es exactamente este rol (cliente, app, base, credenciales, accesos) | Se absorbe: el futuro TenantRegistry de RHPro lee sus bases del registro de Tourniquet (vía export/consulta, fase propia), no duplica tablas |
| D5 | **Modo local como fallback** | Si Tourniquet cae, nadie loguea en ninguna app | RHPro mantiene validación dual de tokens (`specs/03`): token de Tourniquet **o** token local firmado por el propio RHPro. El modo local queda restringido a usuarios de emergencia |
| D6 | **Portal = lanzador** | La pantalla inicial es la lista de apps habilitadas del tenant | `frontend/` de Tourniquet es un portal liviano (Next, `output: "export"`); no es área de administración de negocio, sólo de identidad/registro |
| D7 | **Tourniquet es mecanismo de logueo solamente** | La app del cliente —su back y su front— puede estar **íntegramente remota** a este servidor. No es que RHPro de Chile "falte": es que vive en otro lado, y el IdP igual lo sirve | Por eso el esquema **no** tiene ninguna columna de "servido acá": la ubicación del back/front es un dato de despliegue, no de identidad, y meterlo en la base de control lo volvería un valor que hay que mantener sincronizado con la realidad. `cat_base_datos.host` ya dice dónde vive **la base**; dónde vive la aplicación no le interesa al IdP, que no abre conexiones (D3) |

## 3. Componentes

```
┌──────────────────────────────┐        ┌───────────────────────────────┐
│  Portal (Next, estático)     │        │  tq-api (NestJS)              │
│  - login                     │◀──────▶│  - OIDC: /auth /token         │
│  - selector cliente/app      │        │    /userinfo /jwks /revoke    │
│  - admin básico de accesos   │        │  - Registro: clientes/apps/   │
└──────────────┬───────────────┘        │    bases/usuarios/sesiones    │
               │ redirección OIDC       └──────────────┬────────────────┘
               ▼                                       │ Prisma (único motor: SQL Server)
┌──────────────────────────────┐                       ▼
│ Apps consumidoras            │           ┌───────────────────────┐
│ RHPro AR · RHPro Chile · ... │──JWKS────▶│  Base de control       │
│ (cada una con su DATABASE_URL│           │  `tourniquet`          │
│  y su base de negocio)       │           │  (tablas cat_/idn_/tok_/aud_)         │
└──────────────────────────────┘           └───────────────────────┘
```

- **`tq-api`** (backend Nest): emite y valida tokens, administra el registro. Único dueño de la
  base de control. Sin dependencias de negocio de RHPro.
- **Portal** (frontend Next): login, selector de cliente/app (lista desde
  `usuario_cliente_aplicacion`), pantalla de administración de accesos (Fase 03+).
- **Apps consumidoras**: no conocen la base de control. Sólo la URL de discovery/JWKS.

## 4. Relación con RHPro y con la variante Chile

- **RHPro (AR o Chile) es un RP (relying party) más.** Su `.env` de instalación define a qué
  base habla (D3): el claim `tenant`+`aud` del token sirve para **validar** que el ingreso
  corresponde a esta instalación (y para auditoría), no para elegir conexión en runtime.
- Un mismo build de RHPro sirve a AR y Chile; lo que cambia es el `.env` (`DATABASE_URL`,
  flags de features como `FEATURES=chile`) y los datos de `menumstr` de su base. La estrategia
  completa de variantes por país vive en el plan de migración de RHPro (schema superset,
  gating por `menuCodigo` + features); Tourniquet aporta sólo la entrada común.
- El futuro TenantRegistry de RHPro (plan multibase, si alguna vez se ejecuta) consume el
  registro de bases de Tourniquet como fuente de verdad, leyendo `base_datos` (con las
  credenciales desencriptadas por mecanismo aún no definido — Fase 04+ del plan RHPro).

### 4.1 Un cliente no está en este servidor (D7)

Un tenant del catálogo puede tener su aplicación **enteramente remota**: otro servidor, otra
red, a lo mejor otro datacenter. En el despliegue actual así es:

| Cliente | Back y front | Qué significa |
|---|---|---|
| Cervi | en este servidor | El caso "normal": el IdP y la app conviviendo |
| Marcelino | en este servidor | Y además es donde se desarrolla RHPro hoy |
| Jugos | remoto | Tourniquet emite su identidad igual; la app no está acá |
| Santander | remoto | Ídem, y además es la instalación de Chile |

Esto **no** cambia el modelo. Un cliente es un tenant porque se le emite un token, no porque su
código esté corriendo en el mismo servidor que el IdP. Lo que sigue siendo vrai en todos los
casos:

- El token lleva `tenant` y `aud`; la app valida contra la clave pública de Tourniquet.
- La fila en `cat_base_datos` es **inventario**. Se registra la base del cliente aunque su app
  no se sirva desde acá, y por eso `usuario` es `NOT NULL` con un centinela
  (`N'sin_registrar'`) en vez de admitirse NULL: la base *existe* y se conoce, lo que no se
  conoce todavía es el login con que se le habla.
- `estado` sigue siendo `activo`/`inactivo` del **cliente**, no de dónde esté desplegado.

**Lo que este repo NO tiene y por qué:** ninguna columna "está en este nodo", ningún flag de
deploy, ningún heartbeat de la app remota. Si alguna vez hace falta, es un spec propio: sería
salud de despliegue, que es un dominio distinto del de identidad.

### 4.2 La interfaz de export para el TenantRegistry (Fase 09)

Dos endpoints de lectura, para un `admin_identidad` de ese cliente, y **sin credenciales**:

| Endpoint | Devuelve |
|---|---|
| `GET /registry/bases/:tenant` | Inventario de bases de negocio: `codigo`, `idcliente`, `idaplicacion`, `host`, `base`, `engine`, `estado`, `notas` y el booleano `credencial_registrada` |
| `GET /registry/aplicaciones/:tenant` | Apps del cliente con su base activa: `codigo`, `nombre`, `url_inicio`, `estado` y `base` (el **nombre** de la base, o `null`) |

Las reglas que los gobiernan, y que son la mitad del contrato:

1. **El `:tenant` del path es un filtro, no una autorización.** La sesión del portal dice quién
   pregunta; lo que ese usuario puede ver de *ese* cliente se decide contra `idn_usuario_cliente`,
   con el rol releído de la base en cada pedido y sin caché (invariante de `AGENTS.md`).
2. **Ninguno de los dos devuelve `usuario` ni credencial.** `credencial_registrada` es un
   booleano que responde "¿esta base ya tiene contraseña?" sin decir cuál. Los tipos de la
   respuesta (`BaseInventario`, `AplicacionInventario`) no declaran esos campos, que es la única
   forma de que no salgan por accidente.
3. **El 403 es el mismo** para "no sos admin", "no sos miembro" y "ese cliente no existe".

**El desencripto de credenciales sigue sin diseño, y no se implementa.** No hay ningún endpoint
que devuelva contraseñas de bases de negocio, en esta fase ni en ninguna otra. Cuando el
TenantRegistry de RHPro se ejecute, ese mecanismo se diseña con su propio spec, y probablemente
sea out-of-band: un archivo, el gestor de secretos del cliente, o un cliente de servicio a
servicio. Queda anotado como pendiente, no como supuesto.

## 5. Modelo de confianza

- Tourniquet **no** accede a las bases de negocio de las apps. Registra sus datos de conexión
  (inventario + despliegue asistido) pero no los usa en el flujo de login.
- Cada app confía en Tourniquet vía clave pública (JWKS); Tourniquet confía en las apps vía
  registro `aplicacion` (redirect URIs exactos, `aud` emitida por app).
- El usuario confía en un solo lugar para su contraseña (y futuro MFA): Tourniquet. Las apps
  **no** deben ofrecer cambio de contraseña local; redirigen al portal.

## 6. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Tourniquet cae | Nadie loguea en nada | D5 dual-mode con login local RHPro de emergencia; healthchecks; backup diario de la base de control igual que `rhpro_cervi` |
| Robo de access token | Sesión suplantada 15' | Vida corta, `aud` + `tenant` chequeda en cada request, revocación por `sid` (specs/01) |
| Fuga de la base de control | Filtrado de credenciales de todas las bases del cliente | Cifrado AES-256-GCM de `base_datos` con master key **fuera** del SQL (env/DPAPI); la master key nunca en repo (specs/01 §6) |
| Mezcla de tenants | Un cliente ve/entra a otro | Dato + código: toda consulta de portal/API escopada por `tenant` del token; tests manuales de travesía documentados en criterios de aceptación (`specs/04`) |
| Deriva del IdP hacia authz de negocio | Duplicación con `menumstr`, conflictos | D2 como restricción dura en review: una columna de permiso de negocio en tablas `cat_*` / `idn_*` / `tok_*` / `aud_*` es defecto |
| RF/rotación de claves mal hecha | Tokens válidos tras rotación o sesión rota | `kid` explícito, ventana de solapamiento JWKS, procedimiento en specs/01 §5 |

## 7. Fuera de alcance (por ahora)
- ~~MFA con segundo factor real~~ **Hecho en la Fase 09** (TOTP + códigos de recuperación,
  `specs/01` §8). Lo que la MFA **no** hace y sigue sin hacer: no es recuperación de cuenta (sin
  correo, sin SMS, sin "¿olvidé mi código?"), no protege el egreso (cerrar sesión sigue siendo
  sólo el click), y el enrolamiento lo dispara un `admin_identidad` desde el panel, no el usuario
  solo.
- Federación saliente (login con cuenta Microsoft o Google del cliente) — posible sobre D1, no
  diseñada. Queda registrada como **mejora a futuro** en
  `specs/todo/begin/README.md` § *Federación, si algún día*, con las cuatro decisiones que hay que
  tomar antes de encenderla (verificar vs crear, MFA, `tenant` por usuario, y el fallback local).
  El diseño de `idp_sub` en RHPro es lo que la deja abierta sin rediseñar nada.
- **API de integración y auto-provisioning (decidido, NO implementado).** La dirección está
  tomada: se crea un usuario en Tourniquet, se le asignan sus apps, y eso dispara la creación
  del usuario en las APIs de esas apps, que pueden ser remotas (D7). Es provisionamiento
  hacia el downstream, estilo SCIM, y queda fuera de alcance hasta que tenga spec propio. Ese
  spec tiene que definir al menos:
  - **Quién dispara y quién reintenta.** El alta en Tourniquet y el alta en N apps no son una
    sola transacción. Hace falta una cola con reintentos e idempotencia por
    `(idn_usuario, app)`, porque el mismo evento se va a repetir.
  - **Qué pasa con el fallo parcial.** Si Tourniquet tiene el usuario y dos de tres apps lo
    tienen, el login de la tercera no puede fallar con un 500: tiene que responder con un error
    que diga "tu usuario existe pero en esta app todavía no". Eso es un estado propio del
    usuario, no un fallo.
  - **Quién es la autoridad del login.** Si la app de destino puede crear al usuario, hay que
    decir quién decide que el usuario existe. El token no puede llevar datos que la app destino
    todavía no tiene.
  - **Secretos de las APIs de destino.** Una credencial por app, cifrada como las de
    `cat_base_datos` (`specs/01` §6). Nunca en el repo, nunca en el token.
- Apps que no sean de la casa: cualquier tercero se integra por OIDC estándar, sin spec nuevo.
  El catálogo no las prohíbe: `cat_aplicacion` es genérica y la semilla de `deploy/sql/` no
  asume que todas las apps sean RHPro.

## 8. Configuración: variables de entorno

**Decisión:** el entorno se declara **una sola vez** como esquema **Joi** en
`backend/src/config/env.schema.ts` y se inyecta con `ConfigService` (`@nestjs/config`). No hay
`process.env` leido suelto en el backend.

**Por qué, y por qué no es lo de RHPro.** RHPro declara `joi` como dependencia y **nunca la
importa**: valida cada variable en el punto de uso, en el `useFactory` de cada módulo, y deja lo
demás en `process.env` directo. Acá se centraliza, por dos razones concretas:

1. La cobertura uneven. Con validación distribuida, cada variable está validada exactamente en
   el módulo que la usa, y cada módulo nuevo tiene que acordarse de validarla. El olvido no
   rompe la compilación ni los tests: rompe en producción, a las 3 de la mañana, con un mensaje
   que no nombra la variable.
2. Un IdP no puede arrancar a medias. `TQ_MASTER_KEY` ausente tiene que ser un fallo ruidoso y
   temprano, no un `undefined` que explote cuando alguien firme el primer token.

**Reglas:**

- **Una variable que no está en el esquema no es configuración.** Si el backend la necesita,
  va al esquema primero, con su default o su `required()` y su descripción.
- **Se inyecta, no se lee.** `constructor(private config: ConfigService)`. `process.env` directo
  queda para los `.mjs` de `scripts/`, y solo a través de `scripts/lib/entorno.mjs`.
- **El arranque valida dos veces, y está bien.** `main.ts` valida antes de `NestFactory.create`
  para poder imprimir un mensaje legible (un fallo de DI de Nest no dice qué variable falta);
  `ConfigModule.forRoot({ validationSchema })` valida de nuevo dentro de Nest, para que nada que
  monte `AppModule` por otra vía se saltee el control.
- **Todos los errores juntos.** `abortEarly: false`: si faltan cinco variables, se dicen las cinco
  en una sola pasada, no de a una.
- **Los defaults se aplican, no se adivinan.** Un default es una decisión explícita en el esquema.

**Redacción de valores sensibles (obligatoria).** `TQ_MASTER_KEY`, `DATABASE_URL` y
`TQ_BOOTSTRAP_CLAVE` **no pueden aparecer jamás** en un mensaje de error ni en un log. La regla
concreta: **prohibido aplicar `.pattern()` a una variable sensible**, porque la regla `pattern` de
Joi arma el mensaje con el valor literal (`"TQ_MASTER_KEY" with value "…" fails to match…`) y
eso imprimiría la master key en la consola del operador. Para esas variables se usa `.custom()`,
que no incluye el valor. Como red de seguridad, `redactar()` reemplaza el valor de las variables
sensibles y cualquier fragmento `with value "…"` que se cuele en un mensaje.

**`TQ_MASTER_KEY` se valida con la función que la usa.** El esquema llama a
`decodificarMasterKey()` de `claves/crypto.ts` en vez de reimplementar la regla. Así hay una sola
definición de "qué es una master key válida": si el esquema y el servicio tuvieran reglas
propias, podrían divergir y la app validaría con una clave que después no puede usar para
descifrar.

**Variables desconocidas se permiten** (`allowUnknown: true`). El proceso puede correr junto a
variables de otros servicios, y frenar el arranque por eso sería un falso positivo. El typo que
de verdad importa —el de una variable `required()`— ya lo caza el `required()`.

### 8.1 Dónde vive el `.env`

| Ubicación | Rol |
|---|---|
| `<repo>/.env` | **Único.** Lo usan el backend y todos los scripts. |
| `.env.example` | Catálogo comentado, sin valores reales. |

Las rutas se resuelven desde el archivo (`RUTAS_ENV` en `env.schema.ts`), **no** desde el
directorio de trabajo: con `npm run start --workspaces` el cwd es `backend/`, así que un
`dotenv.config()` a secas leería el `.env` equivocado. **No hay un `backend/.env`**: existió
como fallback por compatibilidad y era una trampa, porque el cliente de Prisma lo carga por su
cuenta al importarse, **antes** del `dotenv.config` de la app y sin que nadie lo pida. Como
`dotenv` no pisa variables ya definidas, ese archivo ganaba siempre y el `.env` de la raíz
quedaba decorativo: con dos claves distintas, la app firmaba con la del `backend/.env` mientras
el canónico tenía otra, y el síntoma ("los codes no se canjean") no señalaba el problema. Un
solo archivo, y si aparece otro se borra.

**En producción no hay `.env`**: la master key y `DATABASE_URL` llegan del gestor de secretos del
cliente. `dotenv` no pisa variables que ya existan en el entorno, así que el `.env` es un no-op
ahí. `.env` está en `.gitignore` y nunca se commitea (ver `specs/push-repo.md` de RHPro para el
precedente: un `.env.prod` con secretos reales terminó commiteado una vez).
