# Fase 05 — Registro demo: cliente, aplicación, base y alta de usuario

**Estado:** ⬜ Pendiente
**Depende de:** [04](fase-04-portal-login.md)
**Repo:** Tourniquet
**Requiere acción del usuario:** **sí** — correr la semilla de catálogo
**Riesgo:** bajo
**Reversible:** sí, `DELETE` por código de cliente/app
**Spec normativo:** `specs/02-base-de-datos.md` §3, §5; `specs/03-integracion-rhpro.md` §5
**Mapa:** `specs/04-fases.md` Fase 01 (registro real) + Fase 02 (lado Tourniquet)

---

## Por qué esta fase va antes del guard dual de RHPro

La Fase 06 pone un cliente OIDC real en RHPro. Para que el `authorize` de RHPro funcione, del otro
lado tiene que existir: la fila de `cat_aplicacion` con sus `redirect_uris` exactos, la fila de
`cat_cliente_aplicacion` que habilita la app para el cliente, y un usuario con membresía. Sin eso,
`/oidc/authorize?client_id=rhpro` responde `unauthorized_client` y no hay nada contra lo cual
integrar.

Además es donde se implementa el **cifrado de credenciales de bases** (`specs/01` §6): hasta acá la
tabla `cat_base_datos` estaba vacía y la primitiva AES-GCM de la 02 no tenía uso real. Registrar
`rhpro_marcelino` con su usuario y clave es el primer caso de uso.

---

## Objetivo

Tener cargado el catálogo mínimo de una instalación: un cliente, una app, una base registrada y un
usuario habilitado, con credenciales de base cifradas y la semilla versionada.

---

## Alcance

**Entra:**

- `deploy/sql/90-semilla-catalogo.sql` (**ya escrito**): cliente `cervi`, app `rhpro` y
  `cat_cliente_aplicacion`. La base `rhpro_marcelino` **no** va en el `.sql`: se registra por
  script, porque la credencial se cifra con IV aleatorio por registro y no se puede escribir en
  un archivo versionado.
- Cifrado AES-256-GCM de `base_datos.usuario` + `credencial_cifrada` al escribir.
- Alta de usuario de prueba: membresía en `idn_usuario_cliente` + habilitación en
  `idn_usuario_cliente_aplicacion`.
- `GET /registry/bases/:tenant` (sólo inventario, **sin** credenciales) como anticipo de la Fase 09.
- Endpoints de lectura del portal para el launcher: `GET /me/apps` devuelve las apps habilitadas
  del usuario en su cliente actual.

**No entra:**

- Alta desde la UI: el panel `admin_identidad` es la Fase 08. Acá todo es SQL.
- `base_datos` de Chile: se agrega cuando exista la base (P4 en el README).
- El intercambio de credenciales de bases por API: **nunca** (`specs/01` §6). Ni ahora ni nunca.
- Cifrado de `mfa_secret_cifrada`: Fase 09.

---

## Tareas

### 1. `90-semilla-catalogo.sql` (ya escrito: revisar y aplicar)

Sólo catálogo no sensible, como manda `specs/02` §5: cliente, aplicación, y el vínculo. **La
semilla no lleva usuarios ni contraseñas** (el primer admin lo crea
`scripts/bootstrap-admin.mjs`; los usuarios de prueba, un script aparte).

```sql
-- 90-semilla-catalogo.sql
-- Catálogo base de una instalación. Idempotente: se puede correr más de una vez.
SET NOCOUNT ON;

-- Cliente
IF NOT EXISTS (SELECT 1 FROM cat_cliente WHERE codigo = 'cervi')
    INSERT INTO cat_cliente (codigo, nombre, estado) VALUES ('cervi', 'Cervecería Cervi', 'activo');

-- Aplicación
IF NOT EXISTS (SELECT 1 FROM cat_aplicacion WHERE codigo = 'rhpro')
    INSERT INTO cat_aplicacion (codigo, nombre, tipo_cliente, redirect_uris_json,
                                origenes_json, estado)
    VALUES ('rhpro', 'RHPro', 'public',
            N'["https://rhpro.cervi.com/auth/callback","http://localhost:3000/auth/callback"]',
            N'["https://rhpro.cervi.com","http://localhost:3000"]', 'activo');

-- Vínculo cliente-aplicación
IF NOT EXISTS (SELECT 1 FROM cat_cliente_aplicacion
               WHERE idcliente = 'cervi' AND idaplicacion = 'rhpro')
    INSERT INTO cat_cliente_aplicacion (idcliente, idaplicacion) VALUES ('cervi', 'rhpro');
```

Al final, `SELECT` de verificación: las tres filas presentes.

**`redirect_uris_json` con dos entradas** (producción y desarrollo) es intencional: son
instalaciones distintas con origins distintos. En la instalación de un cliente, sólo la de
producción: la de `localhost` se saca al desplegar, y la semilla de un cliente se genera con
`scripts/generar-instalacion.mjs` en lugar de usar este archivo (ver `deploy/README.md`).

### 2. Cifrado de credenciales de bases

`src/registro/bd-datos.service.ts`, usando la primitiva de la 02:

- `usuario` en claro (no es secreto: es un login de SQL Server, y la tabla es inventario interno).
- `credencial_cifrada` = AES-256-GCM de la contraseña, con `iv(12)‖tag(16)‖ciphertext` en
  `varbinary(512)`, IV aleatorio por registro.
- `engine` default `'sqlserver'` (`specs/02` §3): **no** hay variante MySQL en este repo, pero la
  columna queda para que el inventario sea legible y para el futuro TenantRegistry de RHPro.
- Escritura siempre por el servicio (cifra antes de insertar). **Nunca** se acepta una credencial
  cifrada desde la API: el endpoint acepta el texto plano, cifra, y no lo devuelve jamás.

### 3. Script de alta de usuario de prueba

`scripts/alta-usuario.mjs`:

- Crea o reutiliza `idn_usuario` (argon2id, `scripts/bootstrap-admin.mjs` reusado), y le inserta
  membresía en `idn_usuario_cliente` con el `rol` que se pase (`user` o `admin_identidad`) y
  habilitación en `idn_usuario_cliente_aplicacion`.
- Imprime el `idusuario` (UUID), que es el valor que en la Fase 06 va a ir en
  `user_per.idp_sub`. Guardarlo: la Fase 06 lo necesita y no se inventa.
- Idempotente por `usuario`.

### 4. Endpoints de lectura

| Endpoint | Devuelve | Auth |
|---|---|---|
| `GET /me` | Usuario + cliente actual + roles | Cookie de sesión del portal |
| `GET /me/apps` | Apps habilitadas del usuario en el cliente actual (`codigo`, `nombre`, `estado`) | Cookie + `idn_usuario_cliente_aplicacion` |
| `GET /registry/bases/:tenant` | Inventario: `codigo`, `host`, `base`, `engine`, `estado` — **sin** `usuario` ni credencial | Rol `admin_identidad` del `:tenant` |

`/registry/bases/:tenant` es el anticipo del export de la Fase 09. Su regla de autorización es
**la que importa**: el `admin_identidad` del tenant `:tenant` sólo, verificado contra
`idn_usuario_cliente`, nunca contra un parámetro. Un `admin_identidad` de `cervi` pidiendo
`/registry/bases/otro` recibe 403.

### 5. Registrar la base `rhpro_marcelino`

Inventario, no conexión (D3 de `specs/00`): Tourniquet **no** abre pool a bases ajenas. Lo que se
guarda es lo que el despliegue asistido necesita saber:

```sql
INSERT INTO cat_base_datos (codigo, idcliente, idaplicacion, host, base, usuario,
                           credencial_cifrada, engine, estado, notas)
VALUES ('rhpro_marcelino', 'cervi', 'rhpro', 'localhost', 'rhpro_marcelino',
        'rhpro_app', <cifrado por script>, 'sqlserver', 'activo', N'Desarrollo local');
```

La credencial la inserta el script, no el `.sql` con texto plano: `scripts/registrar-base.mjs` pide
la contraseña por prompt, cifra y escribe. Un `.sql` con una contraseña es una credencial en el
repo, y `.gitignore` no protege un archivo ya commiteado.

---

## Criterios de aceptación

- [ ] `sql:dev deploy/sql/90-semilla-catalogo.sql` corre dos veces seguidas sin error (idempotente).
- [ ] `cat_cliente('cervi')`, `cat_aplicacion('rhpro')` y `cat_cliente_aplicacion` existen;
      `redirect_uris_json` y `origenes_json` son JSON válido.
- [ ] `cat_base_datos('rhpro_marcelino')` existe con `credencial_cifrada` en binario. Un `SELECT`
      del dump muestra bytes, no texto. Descifrar con la master key devuelve la contraseña correcta
      (verificado por script).
- [ ] `engine='sqlserver'` y no hay ningún `.mysql.sql` en `deploy/` (`AGENTS.md` regla 2).
- [ ] `GET /me` con la cookie del portal devuelve el usuario del bootstrap; sin cookie, 401.
- [ ] `GET /me/apps` devuelve `rhpro` para el usuario habilitado y **lista vacía** para un usuario
      con membresía pero sin fila en `idn_usuario_cliente_aplicacion`.
- [ ] Usuario del cliente `otro` no aparece en `/me/apps` del cliente actual: cerofiltration.
- [ ] `GET /registry/bases/cervi` como `admin_identidad` de `cervi` ⇒ 200 con el inventario, **sin**
      `usuario` ni credencial en el JSON.
- [ ] `GET /registry/bases/otro` como `admin_identidad` de `cervi` ⇒ 403.
- [ ] `GET /registry/bases/cervi` como usuario `user` (no admin) ⇒ 403.
- [ ] El `idusuario` impreso por `alta-usuario.mjs` es un UUID v4 válido; se usa en la Fase 06 tal
      cual.
- [ ] `grep -ri "contrasena\|password" deploy/` no encuentra ninguna credencial en claro.
- [ ] `npm run lint` verde.

---

## Seguridad

| Invariante | Aplicación |
|---|---|
| Credenciales de bases cifradas sobre la marcha | AES-256-GCM, IV aleatorio por registro, master key de env. La columna se escribe sólo desde el servicio |
| Ningún endpoint devuelve credenciales | `/registry/bases` no incluye `usuario` ni `credencial_cifrada` en la respuesta, ni en el `.env`, ni en un log |
| `tenant` del token, nunca del path | `/registry/bases/:tenant` valida que el `admin_identidad` pertenezca a **ese** tenant; si no, 403. El `:tenant` del path es un **filtro**, no una autorización |
| Autorización por rol del tenant | `rol='admin_identidad'` en `idn_usuario_cliente`, leído de la BD en cada request. Sin caché de permisos |
| Semilla sin secretos | `90-semilla-*.sql` lleva sólo catálogo (clientes, apps). Usuarios y credenciales van por script |

## Trampas

1. **`cat_base_datos` tiene un único índice `(idcliente,idaplicacion)` filtrado a `estado='activo'`.**
   Registrar una segunda base activa para la misma combinación falla. Eso es intencional (una base
   activa por app y cliente), pero hay que documentarlo al cliente: las bases inactivas quedan como
   histórico con `estado='inactivo'`.
2. **La cookie de sesión no dice qué cliente está activo.** `/me/apps` usa el cliente del token de
   sesión. Con dos membresías (Fase 07) hace falta un selector: es exactamente lo que la 07 agrega,
   y por eso `/me` desde la 05 devuelve **un** cliente activo (si hay varios, el primero, o error
   explícito si hay ambigüedad). No decidir por omisión: si hay más de una membresía activa y no hay
   selector, `/me` devuelve 409 pidiendo selección.
3. **El `usuario` de `idn_usuario` es único global**, no por tenant. Un mismo login en dos clientes
   es **una** fila en `idn_usuario` con dos `idn_usuario_cliente`. Es lo que dice `specs/02` §3 y lo
   que permite "un solo logueo para toda la suite" (D6 de `specs/00`).
4. **Poner el `redirect_uri` de desarrollo en la semilla y olvidarlo en producción.** Es un
   `localhost` en la lista de URIs de una app de cliente: alguien que corra un IdP en su máquina
   podría canjear codes. La Fase 10 (runbook de despliegue) lo revisa explícitamente.
5. **Imprimir el `idusuario` en el log del script**: es el `idp_sub` del usuario, que es público por
   diseño (va en el token), pero imprimirlo junto a otros datos de conexión en un archivo de log
   compartido es ruido innecesario. Se imprime, porque la Fase 06 lo necesita, y sólo eso.
