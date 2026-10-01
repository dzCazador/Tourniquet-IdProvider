# `specs/todo/begin` — Plan de implementación de Tourniquet, fase por fase

Desglose **ejecutable** de los specs normativos. Cada fase es autocontenida: se abre en una sesión
nueva, se ejecuta de a una y se cierra con sus criterios de aceptación verificados a mano.

> Los specs mandan. Este plan **no** agrega requisitos nuevos: traduce
> `specs/00-arquitectura.md` … `specs/04-fases.md` a unidades de trabajo. Si algo acá contradice un
> spec normativo, gana el spec y esta carpeta se corrige.

---

## Estado

El repo **ya no está vacío**: la 01 a la 08 están hechas. Las primeras se cerraron
con verificación por HTTP sobre `tourniquet_dev` (`npm run verificar:oidc`,
`npm run verificar:portal`) y, en la 04, además con 61 comprobaciones en Chrome
contra el export real. La 07 queda con el pase de navegador pendiente: lo que no se
puede comprobar con `fetch` (axe, 360 px, teclado, `prefers-reduced-motion`) está
marcado `[browser]` en los criterios de la fase.

| Fase | Título | Repo | SQL del usuario | Estado |
|------|--------|------|:---------------:|--------|
| [00](fase-00-login-local-rhpro.md) | Login local real contra `user_per` | RHPro | **Sí** | 🟢 Verificada con dos usuarios reales; queda sólo el caso "menú vacío", que no se reproduce sin tocar `menuaccess` |
| [01](fase-01-scaffold-control.md) | Scaffold del repo + base de control `cat_*` / `idn_*` / `tok_*` / `aud_*` | Tourniquet | **Sí** (prod) | ✅ Completada |
| [02](fase-02-identidad-y-claves.md) | Identidad: argon2id, bootstrap, claves de firma, auditoría | Tourniquet | No | ✅ Completada y verificada |
| [03](fase-03-nucleo-oidc.md) | Núcleo OIDC: discovery, JWKS, authorize, token, revoke, logout | Tourniquet | No | ✅ Completada y verificada |
| [04](fase-04-portal-login.md) | Portal: login, tema gótico, callback decodificado | Tourniquet | No | ✅ Completada y verificada |
| [05](fase-05-registro-demo.md) | Registro demo: cliente, app, base, alta de usuario | Tourniquet | **Sí** (semilla) | ✅ Completada y verificada |
| [06](fase-06-rhpro-dual-guard.md) | RHPro como relying party (guard dual + `idp_sub`) | RHPro | **Sí** | ✅ Completada y verificada (backend + front, con `code` real y en navegador) |
| [07](fase-07-portal-lanzador.md) | Portal lanzador: membresías y lista de apps | Tourniquet | **Sí** (`01-aplicacion-url-inicio.sql`) | ✅ Código cerrado y verificado por HTTP (46 + 186 comprobaciones); queda el pase de navegador |
| [08](fase-08-admin-identidad.md) | Panel `admin_identidad` por cliente | Tourniquet | **Sí** (`02-sesion-motivo-cierre-admin.sql`) | ✅ Código cerrado y verificado por HTTP (41 comprobaciones); queda el pase de navegador |
| [09](fase-09-endurecimiento.md) | Endurecimiento: MFA, rotación, jobs, export de registro | Tourniquet | **Sí** (`03-`, jobs `95-` a `98-`) | ✅ Código cerrado y verificado (RFC 6238 + 135 comprobaciones por HTTP); falta el pase de navegador y el **drill de rotación real** contra un `TQ_ISSUER` de cliente |
| [10](fase-10-despliegue-cliente.md) | Despliegue en un cliente: runbooks e instalación | Tourniquet | **Sí** (`91-semilla-<cliente>.sql`) | 🟡 **Código y documentación cerrados**; falta la ejecución en la máquina del cliente, que es la mayor parte de los criterios |
| [11](fase-11-cierre-fase-01.md) | Cierre de la Fase 01 de `specs/04` | — | No | ⬜ Pendiente |

**Lo único que quedó sin verificar de la 04** es la burbuja del gestor de
contraseñas de **Firefox**: no había Firefox en la máquina. Los prerrequisitos
que el gestor inspecciona están comprobados, y en Chrome se midió de verdad.

**P3 del §"Cosas que hay que decidir antes de arrancar"**, ya resuelta en la 04:
el portal se pintó **austero con el tema en el marco** (anillo, placa grabada,
filete `oxblood`, `Cinzel` en el título) y **no** austero plano. La razón y el
límite de esa línea están en "Decisiones que tomó esta fase", en el archivo de la
04.

### Documento transversal

| Documento | Trata de |
|---|---|
| [estetica-tourniquet.md](estetica-tourniquet.md) | Sistema de diseño del portal: estética gótica (negro, oxblood, placa grabada, tipografía de placa) inspirada en la canción *Tourniquet* de Marilyn Manson, con la letra como guía de tono. Define tokens de color con contraste medido, 5 tipografías OFL, ornamentos SVG propios, movimiento y los requisitos de accesibilidad que corren por encima del tema. **Normativo desde la [Fase 07](fase-07-portal-lanzador.md)**. §11 tiene la implementación de la marca por cliente (Fase 10) |
| [`docs/instalacion.md`](../../docs/instalacion.md) | Guía de instalación **para el administrador de sistemas del cliente**, no para un desarrollador. Complementa a los runbooks, no los reemplaza |

### Trazabilidad con `specs/04-fases.md`

| Spec | Fases de este plan |
|---|---|
| Fase 00 (login local en RHPro) | [00](fase-00-login-local-rhpro.md) |
| Fase 01 (Tourniquet mínimo) | [01](fase-01-scaffold-control.md) → [05](fase-05-registro-demo.md) |
| Fase 02 (RHPro como RP) | [06](fase-06-rhpro-dual-guard.md) |
| Fase 03 (portal lanzador + admin) | [07](fase-07-portal-lanzador.md) + [08](fase-08-admin-identidad.md) |
| Fase 04 (endurecimiento y opciones) | [09](fase-09-endurecimiento.md) + [10](fase-10-despliegue-cliente.md) |

### Gráfico de dependencias

```
00 ──▶ 01 ──▶ 02 ──▶ 03 ──▶ 04 ──▶ 05 ──▶ 06 ──▶ 07 ──▶ 08 ──▶ 09 ──▶ 10
                                │                                    ▲
                                └──── 11 (cierre) ───────────────────┘
```

`11` (el acta de cierre de la Fase 01 de `specs/04`) se puede hacer en cualquier momento
posterior a la `05`: no depende de la `09`.

`11` no es código: es el acta de cierre de la Fase 01 de `specs/04`. Se puede hacer en cualquier
momento posterior a la 05.

### El frontend, a partir de la 04

`frontend/` es **App Router** en `src/app/`, con `output: 'export'` y Tailwind.
La 01 lo había dejado en Pages Router con una sola página de arranque; la 04 lo
migró porque `estetica-tourniquet.md` §10 describe los archivos en `src/design/`
y `src/app/`, y porque `next/font` (las cinco tipografías auto-alojadas que pide
§3) solo se puede usar en App Router o en `_app`.

Dos cosas del build que hay que saber antes de tocarlo:

- **`next build` corta si falta `NEXT_PUBLIC_API_URL`.** En un export estático
  la URL de la API queda incrustada en el bundle, así que sin la variable el
  portal desplegado apuntaría a la `localhost` del navegador de cada usuario, y
  el build terminaría "bien". La comprobación está en `frontend/next.config.js`.
- **Después del build, `out/dev` se borra.** `/dev/token` es una herramienta de
  desarrollo y no puede quedar en un build de producción: el HTML lo saca
  `notFound()` y el archivo lo borra `frontend/scripts/quitar-rutas-dev.mjs`
  (explicado en la 04, "Decisiones que tomó esta fase", punto 5).

---

## Cómo trabajar con esta carpeta

1. Abrir este `README.md` para el índice.
2. Leer la fase completa **antes** de tocar nada. Cada una abre con su encabezado de estado y
   precondiciones; si una precondición no se cumple, la fase no arranca.
3. Leer `AGENTS.md` (raíz) y el spec que la fase declare como normativo (está en su encabezado).
4. Ejecutar la fase. **Al terminar, marcar el `Estado` acá y en el encabezado del archivo de fase.**
5. Si cualquier paso de la fase revela un cambio de diseño, se actualiza **primero** el spec
   normativo, después el código. Al revés no.

### Lo que la Fase 09 corrigió del camino anterior

La `99-verificar-esquema.sql` —el comprobatorio de que los dos caminos del esquema
coinciden— **nunca había corrido bien**, por dos defectos que sólo aparecen cuando
se lo corre de verdad:

1. Filtraba **sólo `cat_*`**, así que un incremental sobre `idn_`, `tok_` o `aud_` pasaba la
   comparación sin aparecer en la huella. La `09` es la primera fase que agrega tablas fuera de
   `cat_`, y también la que hizo visible el agujero.
2. Usaba `sys.foreign_keys.referenced_column_id`, que **no resuelve en SQL Server 2022**
   (probado en la 16.0.1000.6 Express del servidor de desarrollo): la consulta moría con
   Msg 207. Ahora usa `sys.foreign_key_columns`.

Además, los catálogos de SQL Server 2022 traen `nvarchar` con intercalación
`Latin1_General_CI_AS_KS_WS`, y concatenarlo con literales de la base da Msg 451. Las
consultas de verificación llevan `COLLATE DATABASE_DEFAULT` donde mezclan los dos.

### Reglas transversales (mismas que `specs/04` §Reglas)

1. **Prohibido generar tests.** Cero `.spec.ts` / `.test.ts`, cero mocks, cero suites. La
   verificación de cada fase es **manual** contra su lista de criterios, que forma parte del spec.
2. **El agente nunca ejecuta DDL/DML contra una base real.** Sólo `tourniquet_dev`, con la guardia
   de `scripts/ejecutar-sql-dev.mjs`. El SQL de producción y el de las bases de negocio los
   ejecuta el usuario; la fase entrega el `.sql` exacto.
3. **Ninguna tabla nueva sin actualizar `specs/02` primero.** Ningún claim nuevo sin actualizar la
   tabla de `specs/01` §2 primero.
4. **Sin `prisma migrate` / `db push` / `migrate reset`.** Motor único SQL Server, sin variante
   MySQL.
5. **Ninguna credencial, master key, token ni `pwd_hash` en el repo, en los logs ni en los
   ejemplos** de estas fases (`.env.example` lleva placeholders obvios).
6. `npm run lint` verde en cada proyecto tocado antes de cerrar la fase.

---

## Estructura del repo que se va a construir

```
Tourniquet/
├── backend/                     NestJS + Prisma (SQL Server)
│   └── src/
│       ├── prisma/              PrismaService + schema.prisma (modelos cat_/idn_/tok_/aud_)
│       ├── oidc/                discovery, jwks, authorize, token, revoke, logout, userinfo
│       ├── auth/                login del portal, sesión, auditoría, rate limit
│       ├── claves/              tok_clave_firma, rotación, master key (AES-256-GCM)
│       ├── registro/            cliente, aplicación, cliente_aplicacion, base_datos
│       ├── sesiones/            tok_sesion, refresh, codes
│       └── registro-api/        (Fase 08) admin_identidad
├── frontend/                    Next.js App Router, output: "export"
│   ├── src/app/                 /login, / (lanzador), /apps/puerta, /consentimiento,
│   │                                   /mi-cuenta, /logout/despedida, /admin (08)
│   └── src/design/              tokens del tema gótico, ornamentos, componentes base
├── deploy/
│   ├── sql/                     NN-titulo.sql versionado (SQL Server)
│   └── runbooks/                rotación de claves, restore, migración, rollback
├── scripts/                     ejecutar-sql-dev.mjs, bootstrap-admin.mjs, gen-clave
├── specs/                       lo que estás leyendo
├── package.json                 workspaces: backend, frontend
└── .env.example                 placeholders, sin secretos
```

---

## Reglas de escritura de los archivos de fase

Cada archivo sigue esta estructura, para que se puedan leer en cualquier orden:

| Sección | Qué lleva |
|---|---|
| Encabezado | Estado, depende de, repo, requiere acción del usuario, riesgo, reversible, spec normativo |
| Por qué esta fase va acá | El razonamiento que justifica el orden (qué se rompe si se saltea) |
| Objetivo | Una frase |
| Alcance / Fuera de alcance | Qué entra y qué NO entra (lo NO entra se anota en la fase 09 como pendiente) |
| Tareas | Numeradas, con los archivos exactos a crear o tocar |
| SQL | El `.sql` exacto que ejecuta el usuario, o "ninguno" |
| Criterios de aceptación | Checklist manual, la definición de "terminada" |
| Seguridad | Los invariantes de `AGENTS.md` que esta fase puede pisar |
| Trampas | Lo que se va a romper |

---

## Lo que este plan NO cubre (y queda en `specs/00` §7)

- MFA con segundo factor real → [09](fase-09-endurecimiento.md), diseño cerrado en `specs/01` §8.
- **Federación saliente (login con Google, Microsoft, Entra del cliente) → mejora a futuro, no
  ahora.** Queda como candidata de la [09](fase-09-endurecimiento.md) **con condiciones**, y si se
  aprueba necesita spec propio. Ver *Federación, si algún día* más abajo: por qué no aporta nada
  hoy y qué habría que decidir antes de encenderla.
- Auto-provisioning de `user_per` en RHPro → fuera de alcance hasta que un contrato lo pida.
- Cliente *confidential* con `client_secret` (backend-a-backend) → no diseñado.
- Multi-motor (MySQL) → **no existe** en este repo; SQL Server es el motor único.

### Federación, si algún día

Tourniquet **ya habla OIDC** (D1): es proveedor para RHPro, el portal y las apps. Eso no es lo mismo
que aceptar cuentas de Google: sería Tourniquet como *broker*, y es otra pieza.

Por qué no es prioridad:

- **No aporta al caso que ya resuelve.** El login de RHPro no habla con Google: habla con Tourniquet
  y, si Tourniquet cae, con su base local. Google sería un eslabón más en una cadena que ya
  funciona.
- **Agrega una dependencia externa que puede sacar gente del sistema.** D5 ("si Tourniquet no
  responde, RHPro tiene que poder loguear") ya es la restricción más dura del diseño. Federar
  multiplica esa superficie por cada proveedor externo que se sume, y un tercero puede caerse o
  cambiar su API sin aviso.
- **Google entra por detrás, nunca al lado de RHPro.** Por eso, si algún día se federase, el
  fallback local de RHPro seguiría intacto: el proveedor externo no está en el camino crítico.

Por qué **queda abierta** y no descartada:

- El vínculo de RHPro es `user_per.idp_sub`, un **UUID de Tourniquet**, no un email ni un nombre. Ese
  diseño ya es el que hace posible federar después sin tocar la base de negocio: el `sub` sigue
  siendo "el UUID que Tourniquet le asignó a este operador", venga de donde venga la verificación.
- D1 se eligió como OIDC estándar justamente para que esto no obligue a rediseñar nada.

Antes de encenderla hay que decidir, por escrito:

1. **¿Federar verifica o crea?** Sólo *verifica* una identidad que un administrador habilitó (igual
   que hoy: alta manual, `idp_sub` en NULL hasta que se da de alta), o el proveedor puede crear
   usuarios y tenants solo. La segunda opción abre la puerta que D2 explícitamente cierra.
2. **¿MFA?** Un segundo factor que vive en Tourniquet no dice nada del que el proveedor ya
   controló. Sin respuesta, federar es degradar la seguridad de las cuentas más sensibles.
3. **¿Un `tenant` o varios?** Una misma persona puede tener cuentas en varios clientes. Con
   federation el `tenant` deja de derivarse del `usuario` y hay que decidirlo explícitamente.
4. **¿Y si el proveedor se cae?** Tiene que existir el mismo camino de hoy: el operador entra por
   login local, con su `idp_sub` ya vinculado.

---

## Cosas que hay que decidir antes de arrancar

| # | Decisión | Por qué bloquea | Default propuesto |
|---|---|---|---|
| P1 | ¿`specs/04` Fase 00 se ejecuta primero en el repo RHPro? | D5 de `specs/00` (fallback local) no es opcional | Sí, antes que la 01 |
| P2 | ¿El agente tiene permiso para correr `ejecutar-sql-dev.mjs` sobre `tourniquet_dev`? | Sin eso la 01 se entrega en SQL y no verificada | Pedirlo explícitamente al arrancar la 01 |
| P3 | ¿El portal muestra el tema gótico en la Fase 04 o se deja en austero hasta la 07? | La 04 es técnica; la estética pide pantallas reales | austero en 04, gótico en 07 (y `estetica-tourniquet.md` es normativo desde la 07) |
| P4 | ¿Chile entra con `aud` propio (`rhpro-chile`) o con claim `base` distinto? | Alta de la app en la 05 | `rhpro-chile` con `aud` propio (más simple de razonar) |
