# `specs/todo/begin` — Plan de implementación de Tourniquet, fase por fase

Desglose **ejecutable** de los specs normativos. Cada fase es autocontenida: se abre en una sesión
nueva, se ejecuta de a una y se cierra con sus criterios de aceptación verificados a mano.

> Los specs mandan. Este plan **no** agrega requisitos nuevos: traduce
> `specs/00-arquitectura.md` … `specs/04-fases.md` a unidades de trabajo. Si algo acá contradice un
> spec normativo, gana el spec y esta carpeta se corrige.

---

## Estado

**Repo vacío**: no hay `backend/`, `frontend/`, `deploy/`, `scripts/`, `package.json` ni commits.
Todo lo que sigue hay que crearlo. Las fases 00-01 son las que arrancan.

| Fase | Título | Repo | SQL del usuario | Estado |
|------|--------|------|:---------------:|--------|
| [00](fase-00-login-local-rhpro.md) | Login local real contra `user_per` | RHPro | **Sí** | ⬜ Pendiente |
| [01](fase-01-scaffold-control.md) | Scaffold del repo + base de control `cat_*` / `idn_*` / `tok_*` / `aud_*` | Tourniquet | **Sí** (prod) | ⬜ Pendiente |
| [02](fase-02-identidad-y-claves.md) | Identidad: argon2id, bootstrap, claves de firma, auditoría | Tourniquet | No | ✅ Completada y verificada |
| [03](fase-03-nucleo-oidc.md) | Núcleo OIDC: discovery, JWKS, authorize, token, revoke, logout | Tourniquet | No | ⬜ Pendiente |
| [04](fase-04-portal-login.md) | Portal: login, tema gótico, callback decodificado | Tourniquet | No | ⬜ Pendiente |
| [05](fase-05-registro-demo.md) | Registro demo: cliente, app, base, alta de usuario | Tourniquet | **Sí** (semilla) | ⬜ Pendiente |
| [06](fase-06-rhpro-dual-guard.md) | RHPro como relying party (guard dual + `idp_sub`) | RHPro | **Sí** | ⬜ Pendiente |
| [07](fase-07-portal-lanzador.md) | Portal lanzador: membresías y lista de apps | Tourniquet | No | ⬜ Pendiente |
| [08](fase-08-admin-identidad.md) | Panel `admin_identidad` por cliente | Tourniquet | No | ⬜ Pendiente |
| [09](fase-09-endurecimiento.md) | Endurecimiento: MFA, rotación, jobs, export de registro | Tourniquet | **Sí** (jobs) | ⬜ Pendiente |
| [10](fase-10-despliegue-cliente.md) | Despliegue en un cliente: runbooks e instalación | — | **Sí** | ⬜ Pendiente |
| [11](fase-11-cierre-fase-01.md) | Cierre de la Fase 01 de `specs/04` | — | No | ⬜ Pendiente |

### Documento transversal

| Documento | Trata de |
|---|---|
| [estetica-tourniquet.md](estetica-tourniquet.md) | Sistema de diseño del portal: estética gótica (negro, oxblood, placa grabada, tipografía de placa) inspirada en la canción *Tourniquet* de Marilyn Manson, con la letra como guía de tono. Define tokens de color con contraste medido, 5 tipografías OFL, ornamentos SVG propios, movimiento y los requisitos de accesibilidad que corren por encima del tema. **Normativo desde la [Fase 07](fase-07-portal-lanzador.md)** |

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
                                │                     ▲
                                └──── 11 (cierre) ────┘
```

`11` no es código: es el acta de cierre de la Fase 01 de `specs/04`. Se puede hacer en cualquier
momento posterior a la 05.

---

## Cómo trabajar con esta carpeta

1. Abrir este `README.md` para el índice.
2. Leer la fase completa **antes** de tocar nada. Cada una abre con su encabezado de estado y
   precondiciones; si una precondición no se cumple, la fase no arranca.
3. Leer `AGENTS.md` (raíz) y el spec que la fase declare como normativo (está en su encabezado).
4. Ejecutar la fase. **Al terminar, marcar el `Estado` acá y en el encabezado del archivo de fase.**
5. Si cualquier paso de la fase revela un cambio de diseño, se actualiza **primero** el spec
   normativo, después el código. Al revés no.

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
│   ├── src/app/                 /login, /callback, /apps, /admin, /mi-cuenta
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
- Federación saliente (AD/Entra del cliente) → decisión pendiente, spec propio si se aprueba.
- Auto-provisioning de `user_per` en RHPro → fuera de alcance hasta que un contrato lo pida.
- Cliente *confidential* con `client_secret` (backend-a-backend) → no diseñado.
- Multi-motor (MySQL) → **no existe** en este repo; SQL Server es el motor único.

---

## Cosas que hay que decidir antes de arrancar

| # | Decisión | Por qué bloquea | Default propuesto |
|---|---|---|---|
| P1 | ¿`specs/04` Fase 00 se ejecuta primero en el repo RHPro? | D5 de `specs/00` (fallback local) no es opcional | Sí, antes que la 01 |
| P2 | ¿El agente tiene permiso para correr `ejecutar-sql-dev.mjs` sobre `tourniquet_dev`? | Sin eso la 01 se entrega en SQL y no verificada | Pedirlo explícitamente al arrancar la 01 |
| P3 | ¿El portal muestra el tema gótico en la Fase 04 o se deja en austero hasta la 07? | La 04 es técnica; la estética pide pantallas reales | austero en 04, gótico en 07 (y `estetica-tourniquet.md` es normativo desde la 07) |
| P4 | ¿Chile entra con `aud` propio (`rhpro-chile`) o con claim `base` distinto? | Alta de la app en la 05 | `rhpro-chile` con `aud` propio (más simple de razonar) |
