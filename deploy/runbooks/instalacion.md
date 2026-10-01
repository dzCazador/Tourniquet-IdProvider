# Runbook — Instalación de Tourniquet en un cliente

Motor: **SQL Server**. Un cliente, una instancia, una base de control
(D3 de `specs/00-arquitectura.md`). Este runbook lleva de **cero a login
funcionando** y termina con una prueba de humo que hay que hacer **en la máquina
del cliente, con el cliente mirando**.

- **Reversible:** sí, paso por paso, con `rollback.md`.
- **DDL de las bases de negocio: lo ejecuta el cliente.** Acá solo lo de la base de
  control.
- **Certificados: los emite el cliente.** Acá se verifica el requisito.
- **Linux:** los comandos de abajo son de Windows porque el despliegue que se
  conoce es Windows Server. Con Linux cambian el nombre del servicio y nada más;
  el orden es el mismo y la lista de comprobaciones es la misma.

> **Antes de empezar, leer la §1.** El error que más cuesta en un despliegue OIDC
> no es de configuración: es el **reloj del servidor**. Va primero a propósito.

---

## 1 · Requisitos, verificados antes de tocar nada

Todos tienen que estar **verificados**, no "pedidos". Cada uno es una comprobación
con una salida concreta.

| # | Requisito | Cómo se verifica | Si falla |
|---|---|---|---|
| 1.1 | **Reloj del servidor sincronizado (NTP)** | `w32tm /query /status` → *Source* dice un servidor NTP y *Last Successful Sync Time* es de hoy. En Linux, `timedatectl status` | Parar. Todo lo demás es inútil con el reloj mal |
| 1.2 | **Certificado válido** para el dominio del `issuer` | En el navegador, abrir `https://<dominio-del-issuer>/` y ver que no hay aviso de seguridad. Nada de `NET::ERR_CERT` | Emitirlo. Es del cliente |
| 1.3 | **DNS**: el dominio del `issuer` resuelve al servidor del backend | `nslookup <dominio-del-issuer>` | Corregir el DNS antes de seguir |
| 1.4 | **SQL Server accesible** y con una base creada y vacía | `sqlcmd -S <srv> -U <usr> -P <pwd> -Q "SELECT DB_NAME(), @@VERSION"` | Que lo haga el DBA del cliente |
| 1.5 | **Puerto 443 abierto** desde las máquinas de los empleados hasta el backend | Desde una máquina de usuario: `Test-NetConnection <dominio> -Port 443` | Con el cortafuegos del cliente |
| 1.6 | **Un contacto del cliente** que sepa quién es el administrador de cuentas | Nombre, mail y teléfono, anotados en el acta | Antes de empezar |

### Por qué el reloj es el paso 1 y no una nota al pie

Con el reloj **adelantado**, todos los tokens que el IdP emite parecen
"expirados en el futuro" y las apps los rechazan. Con el reloj **atrasado**, el
IdP emite tokens que nacen en el futuro y las apps los rechazan por `nbf`. En los
dos casos el mensaje que ve el empleado es "sesión inválida", que no apunta a la
hora. Es el fallo que más tiempo cuesta porque todo lo demás parece correcto: el
discovery responde, el JWKS responde, el login entra, y el deep-link a la app no.

Y es el que no se nota en la etapa de pruebas: la máquina de desarrollo tiene el
reloj bien puesto porque el problema sería visible en cualquier página.

**Cuarenta minutos de reloj adelantado en el servidor del cliente son un
incidente de producción de cuarenta minutos.**

---

## 2 · Desplegar el backend

En el servidor del `issuer`:

```bash
git clone <repo> tourniquet
cd tourniquet
npm ci
npm run build            # compila backend/dist
```

**No hay `npm start`.** El proceso lo maneja un servicio del sistema:

### Windows (servicio)

```powershell
# El servicio corre como una cuenta de dominio de servicio propia, con el minimo
# de permisos: no interactiva, sin escritorio, sin derecha de inicio de sesion.
sc.exe create TourniquetApi ^
  binPath= "C:\Program Files\nodejs\node.exe C:\inetpub\tourniquet\backend\dist\main.js" ^
  start= auto ^
  obj= "DOMINIO\svc-tourniquet"
sc.exe description TourniquetApi "IdP OIDC de Tourniquet (backend)"
sc.exe failure TourniquetApi reset= 86400 actions= restart/5000/restart/10000/restart/30000
sc.exe failureflag TourniquetApi 1
sc.exe start TourniquetApi
```

`sc failure ... actions= restart/...` es la **recuperación ante fallos**, y es un
criterio de aceptación de esta fase: con el default de Windows, un servicio que
cae se queda caído hasta que alguien lo mira. Las tres acciones son 5 s, 10 s y
30 s: se reinicia rápido y no se insiste para siempre.

> `binPath=` **con el espacio después del `=`**. `sc.exe` es de 1995 y sin el
> espacio toma el nombre del servicio como si fuera el ejecutable. Con
> comillas rectas, no tipográficas.

El directorio de trabajo del servicio es el que resuelve `RUTAS_ENV` (tres niveles
arriba de `dist/main.js`, o sea **la raíz del repo**), así que el `.env` tiene que
estar en `C:\inetpub\tourniquet\.env`.

### Linux (systemd)

```ini
# /etc/systemd/system/tourniquet-api.service
[Unit]
Description=Tourniquet IdP OIDC
After=network-online.target

[Service]
Type=simple
User=svc-tourniquet
WorkingDirectory=/opt/tourniquet
ExecStart=/usr/bin/node /opt/tourniquet/backend/dist/main.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## 3 · Variables de entorno

Copiar `.env.example` a `.env` y completar **lo de esta tabla**. Lo demás se deja
como está.

```env
NODE_ENV=production
PORT=3001

# Origen del portal. Vacio = CORS deshabilitado, que NO sirve con el portal.
# El portal y el IdP van al mismo servidor web en el despliegue de referencia,
# asi que el origen es el del issuer.
CORS_ORIGIN=https://auth.cervi.com

# La base de control DEL CLIENTE. Usuario de aplicacion con permisos minimos.
DATABASE_URL=sqlserver://tq_app@SQL-CERVI:1433;database=tourniquet;user=tq_app;password=***;encrypt=true;trustServerCertificate=true;connectionTimeout=15

# EXACTAMENTE el mismo string que el certificado y que el discovery.
# Sin barra al final, sin www, https.
TQ_ISSUER=https://auth.cervi.com

# URL base del portal. La usa /oidc/authorize para mandar al login.
TQ_PORTAL_URL=https://auth.cervi.com

# Del gestor de secretos. NO va en este archivo: ver la nota de abajo.
TQ_MASTER_KEY=<32 bytes en base64, 44 caracteres>

ACCESS_TTL_MIN=15
RATE_LIMIT_POR_MINUTO=10
TQ_ROTACION_HABILITADA=false
```

### Las cuatro reglas que el arranque verifica y hace fallar

No son recomendaciones: `backend/src/config/env.schema.ts` corta el proceso con un
mensaje que dice exactamente qué está mal, **antes** de levantar.

| Regla | Qué pasa si no se cumple |
|---|---|
| `TQ_ISSUER` en `https` cuando `NODE_ENV=production` | El proceso no levanta. El discovery no anuncia un issuer `http` y el token viajaría en claro |
| `TQ_MASTER_KEY` presente y con 32 bytes base64 exactos | El proceso no levanta, con el largo esperado en el mensaje. **El valor no se imprime nunca** |
| `DATABASE_URL` sin `database=tourniquet_dev` en producción | El proceso no levanta. Es la barrera contra arrancar el IdP de un cliente contra la base de desarrollo |
| `DEBUG` no definida en producción | El proceso no levanta. Un `DEBUG` de una sesión de diagnóstico que quedó puesto es un parámetro que no debería viajar |

### La master key no va en este archivo

`TQ_MASTER_KEY` **se inyecta desde el gestor de secretos del cliente** (Key Vault,
CyberArk, el que sea) como variable de entorno del servicio, **no** como una línea
del `.env`.

Que el proceso la lea del entorno y no del archivo es exactamente lo que hace que
las dos cosas puedan convivir: `dotenv` no pisa variables que ya existan, así que en
producción la clave del gestor gana y el `.env` es un no-op (`backend/src/main.ts`).

**Nunca** en texto plano en el servidor: ni en el `.env`, ni en un archivo del
escritorio, ni en el historial de un shell. Ver `backup-restore.md`, que es donde se
dice **dónde** vive y **quién** la tiene.

### Permisos mínimos del usuario de SQL

Un login de aplicación, con lo siguiente y nada más:

```sql
-- Se ejecuta UNA vez, con el DBA. Usuario de aplicacion, no un sysadmin.
USE [tourniquet];
CREATE USER [tq_app] FOR LOGIN [tq_app];
GO
-- DDL, datos y las cuatro secuencias de la auditoria y los jobs.
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::dbo TO [tq_app];
-- `aud_login` y `tok_*` los escribe y los lee la app; `cat_*` tambien.
-- SIN ALTER, SIN DROP, SIN db_owner, SIN db_datareader.
```

> Sin permiso de `DELETE` sobre `aud_login` **no** la app puede borrar (no lo
> hace: es append-only), pero sí lo necesitan los jobs de retención, que corren
> con **otra** cuenta. Ver `jobs-limpieza.md`: son dos cuentas distintas, y esa
> separación es deliberada.

---

## 4 · Crear el esquema

```bash
sqlcmd -S SQL-CERVI -U sa -P *** -b -i deploy/sql/00-crear-base.sql
```

Un solo archivo, y es el **camino (A)** de `specs/02` §5.1: base nueva, esquema
completo y vigente. Es idempotente, así que correrlo de nuevo completa lo que
falte y no toca lo que ya está.

> `00-crear-base.sql` **no** lleva `DROP DATABASE`, y eso es a propósito: es el
> archivo que se corre en producción, y un script de creación que puede borrar la
> base que está por crear no es un script de creación.

Después, la huella del esquema, que se guarda en el acta de instalación:

```bash
sqlcmd -S SQL-CERVI -U sa -P *** -d tourniquet -b -W -s "|" \
  -i deploy/sql/99-verificar-esquema.sql -o huella_instalacion.txt
```

---

## 5 · Generar la master key

```bash
npm run generar:clave
```

Imprime `TQ_MASTER_KEY=<44 caracteres>`. Se copia **al gestor de secretos del
cliente** y de ahí al servicio. A nowhere más.

> Sin copia de seguridad de esta clave, **no hay restore posible**. Si se pierde,
> hay que regenerar `tok_clave_firma` y volver a cifrar todas las credenciales de
> bases de negocio y todos los secretos de MFA. Es lo que dice
> `backup-restore.md` y es la razón por la que ese runbook pide decidir **dónde
> se guarda y quién la tiene** antes de seguir con el paso 6.

---

## 6 · La semilla del cliente

En la máquina donde se prepara el despliegue (no tiene que ser el servidor):

```bash
npm run generar:instalacion
```

Pregunta el código y nombre del cliente, los dominios, el de la base de negocio y
el tema, y escribe **`deploy/sql/91-semilla-<cliente>.sql`**. Todo lo que se pide
tiene validación, y lo que no se puede aceptar se corta con el motivo: un `issuer`
en `http`, un `redirect_uri` de otro origen, un acento que no sea `#rrggbb`.

> **Dónde va ese archivo.** Al `deploy/sql/` del repo de la instalación, que es lo
> correcto. Si el `deploy/` donde se está generando es el del repo de
> **desarrollo** de Tourniquet, el dominio del `issuer` no describe ninguna
> instalación real: en ese caso va con `--salida` a la carpeta donde se prepara el
> despliegue, y al repo del cliente por el canal que el cliente use.

> **No se usa `90-semilla-catalogo.sql` en un cliente.** Ese archivo lleva
> `localhost` en los `redirect_uri` de la app, y un `localhost` que queda en
> `cat_aplicacion.redirect_uris_json` de una instalación real es un
> `redirect_uri` **válido para siempre**: alguien que corra un IdP en su máquina
> podría canjear codes (`specs/01` §9, trampa 5 de la fase 10).

```bash
sqlcmd -S SQL-CERVI -U tq_app -P *** -d tourniquet -b \
  -i deploy/sql/91-semilla-cervi.sql
```

Al final imprime una verificación con **cinco chequeos que tienen que dar 0**
(`uris_no_https`, `clientes_activos` = 1, `hashes_no_argon2id`,
`usuarios_sin_clave_firma`, `registros_a_medias`).

**La salida completa se guarda en el acta.** Es el registro de qué se cargó.

---

## 7 · Registrar la base de negocio

La credencial **se cifra** en el momento: `AES-256-GCM` con IV aleatorio por
registro (`specs/01` §6). Por eso esto no puede ser un `.sql` y por eso lo corre
una persona con la clave, no un pipeline.

```bash
npm run registrar:base
```

Después, el **inventario tiene que mostrar la base con credencial** y no con el
centinela `sin_registrar`:

```bash
curl -s -H "Authorization: Bearer <token-de-admin>" \
  https://auth.cervi.com/registry/bases/cervi | jq
```

> `sin_registrar` es un **centinela**, no un login. Es lo que dice la columna
> `usuario` mientras la base está inventariada pero a la que todavía no se le habla
> a nadie. El código compara contra ese valor antes de armar cualquier conexión,
> porque un string de conexión armado con él falla con "login failed", que no dice
> "no lo registraste".

---

## 8 · El primer administrador

```bash
npm run bootstrap:admin
```

Pide usuario y clave **por prompt** (nunca por flag, nunca por `.env` en texto), hashea
con argon2id, crea la clave de firma si no existe y verifica que la clave cumpla
la política de `specs/01` §8.1.

Es el mismo script que arma al administrador de un desarrollo. Lo que lo hace
irreversible es la master key: **cualquiera que pueda correr este script contra la
base ya es dueño del IdP**, y esa es la razón por la que no es un endpoint HTTP.

---

## 9 · Habilitar el acceso de las personas

1. **Alta de la primera persona real** (desde el portal, con la sesión del admin):

   `/admin/usuarios` → alta → rol, apps habilitadas, y MFA si corresponde.

   O por script, para altas de carga: `npm run alta:usuario`.

2. **MFA**: opcional por persona, y **activado por omisión** para cualquier rol
   que pueda tocar accesos (`specs/01` §8). La alta por script no lo activa.

---

## 10 · Desplegar el portal

El portal es un **export estático**. No hay servidor de Node, no hay `next start`:

```bash
cd frontend
NEXT_PUBLIC_API_URL=https://auth.cervi.com npm run build
```

Se copia `frontend/out/` al servidor web que sirve el `issuer`.

### `NEXT_PUBLIC_API_URL` no es opcional y no se cambia después

La URL de la API se **incrusta en el bundle** durante el build: el export es
estático y no hay runtime donde configurarla. Por eso `next.config.js` **corta el
build** si falta la variable, en vez de avisar: un build sin ella termina bien y
produce un portal cuyo login apunta a `http://localhost:3001`, que funciona en la
máquina de quien lo compiló y en ninguna otra. Ese síntoma se descubre tarde y es
muy confuso.

Tiene que ser **exactamente** `TQ_ISSUER`. Si no coinciden, la cookie de sesión se
escribe en un origen y el authorize la lee de otro.

### Cabeceras que el servidor web tiene que servir

El export es estático, así que **el servidor web del cliente es el que define el
CSP**, no el backend (que solo define el suyo, en `main.ts`).

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self' https://auth.cervi.com;
  form-action 'self';
  frame-ancestors 'none';
  object-src 'none';
  base-uri 'self'

Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

- **`connect-src`** tiene que permitir el origen de la API, porque el portal pide
  `/marca`, `/auth/session` y `/me` desde el navegador. Si el portal y la API
  están en el **mismo** origen, `'self'` alcanza.
- **`style-src` necesita `'unsafe-inline'`**: el acento del tema se escribe en una
  variable CSS del `<html>` en runtime (`frontend/src/design/marca.tsx`), y
  Next inyecta el estilo de las fuentes en el `<head>`. Es la misma decisión que
  toma el backend con su propio CSP, y por el mismo motivo: el valor viene de la
  configuración de la instalación, y la barrera real de qué se puede escribir
  adentro está en el backend (`esHexEstricto`), no en el CSP.
- **`font-src 'self'`**: las fuentes son del paquete de `next/font`, no de un CDN.
  Una CDN de terceros sería un tercero en el camino de cada ingreso.

### Cookies

El backend emite la cookie de sesión del portal. Si el portal y la API están en
**subdominios distintos**, la cookie necesita `SameSite=None; Secure` y el navegador
la rechaza si no. **La causa #1 de "el login entra y al refrescar da 401" en un
despliegue con dos subdominios es esa.** Con portal y API en el mismo origen —que
es el despliegue de referencia— no hace falta.

---

## 11 · Configurar RHPro y **probar el login local primero**

Este es el orden que importa, y es intencional:

1. **RHPro con `AUTH_MODO=local`** y su login local funcionando **probado**.
2. Recién después, `AUTH_MODO=dual`.

Al revés, si el `UPDATE` de `idp_sub` queda a medias, la persona existe en el IdP y
en `user_per` con un `sub` distinto del que tiene el token, y **no entra a ninguna
parte**: ni por Tourniquet ni por local. El login local funcionando es la red de
seguridad de todo el despliegue (D5 de `specs/00`).

```env
# En el `.env` de RHPro, del cliente.
AUTH_MODO=dual              # `local` mientras se prueba el paso 1
TQ_ISSUER=https://auth.cervi.com
TQ_AUDIENCE=rhpro
TQ_TENANT=cervi
```

Y el DDL de `user_per.idp_sub` en la base de negocio del cliente — **que ejecuta el
cliente**, con su variante `.mysql.sql` si usa MySQL (política del repo RHPro).

---

## 12 · Prueba de humo

Se hace **en la máquina del cliente**, con el cliente mirando. Los diez puntos
tienen que pasar **enteros**; un nueve y medio no es un nueve y medio.

| # | Qué | Cómo se mira |
|---|---|---|
| 1 | El discovery responde por `https` y el `issuer` coincide con el dominio configurado | `curl -s https://auth.cervi.com/.well-known/openid-configuration \| jq -r .issuer` → exactamente `https://auth.cervi.com`. Sin barra, sin `www` |
| 2 | El JWKS responde y expone **una clave activa** | `curl -s https://auth.cervi.com/.well-known/jwks.json \| jq '.keys[].kty'` → `RSA` |
| 3 | El administrador del bootstrap entra al portal | `/login` en un navegador **normal**, no en incógnito: el wordmark tiene que decir el nombre del cliente |
| 4 | La lista de apps muestra la app del cliente **con su nombre** | El lanzador muestra `RHPro`, no `localhost` ni un código |
| 5 | El deep-link entra a la app y crea sesión | Click en la placa → la app abre con la sesión creada, sin volver a pedir usuario y clave |
| 6 | Logout de app y logout central, **por separado** | Logout en la app: vuelve a pedir clave y **no** cierra la sesión central. Logout central: cierra el portal y también la de la app |
| 7 | **Login local de RHPro con `AUTH_MODO=local`**, con **Tourniquet apagado** | Parar el servicio `TourniquetApi`, entrar a RHPro con usuario y clave de siempre, y entrar. Después prenderlo |
| 8 | Una persona no habilitada recibe 401 | Un usuario dado de baja o sin app habilitada: el authorize falla y el portal no lo deja entrar |
| 9 | El panel lista los usuarios del cliente y **ninguno de otro** | Con la sesión de admin de `cervi`: `/admin/usuarios` solo muestra los de `cervi` |
| 10 | **Backup hecho y restore probado** | Ver `backup-restore.md`. Un backup no probado no es un backup |

El punto 7 es el que no es opcional: un despliegue donde el único acceso es por
Tourniquet y Tourniquet está caído **no tiene salida**. Y el punto 10 es el que más
se olvida y el que más caro sale.

---

## 13 · Entrega

Antes de dar por cerrada la instalación, en el acta quedan anotados:

- [ ] Fecha, quién instaló, quién del cliente{Homologó.
- [ ] El `issuer` **exacto**, copiado y pegado (no reescrito).
- [ ] Los `kid` de las claves de firma (`npm run rotar:clave`).
- [ ] Dónde está la master key y quién la tiene.
- [ ] Cuándo se hizo el primer backup y **dónde se probó el restore**.
- [ ] Quién tiene la **cuenta de emergencia** de RHPro, y dónde están sus
      credenciales (`emergencia.md`).
- [ ] La lista de **lo que no se instaló** (trampas, decide después).
- [ ] La salida de `99-verificar-esquema.sql` y de la verificación de la semilla.
- [ ] Las cuatro verificaciones de arranque, confirmadas en el log del servicio.

---

## 14 · Después de la instalación: la lista de trampas

Cosas que se olvidan, y que por eso quedan escritas:

1. **El reloj.** Verificada en el paso 1.1, **de nuevo** si el servicio de
   Windows se reinicia solo y el salto de hora salta.
2. **El certificado y el `issuer` son el mismo string.** Si el certificado renueva
   con un SAN nuevo, hay que actualizar `TQ_ISSUER` **y** las apps **juntas**, en
   la misma ventana. Con la regla de `emergency.md` abierta, la ventana no es
   crítica.
3. **Un `localhost` que queda de la semilla de desarrollo.** Un `redirect_uri` de
   desarrollo en una base de producción es un destino válido para siempre, y se
   descubre cuando alguien lo usa.
4. **La base de control sin backup, o con la master key en el servidor.** Si el
   servidor de base se cae el día 1, se pierde la identidad de toda la empresa.
5. **No probar el camino de emergencia.** Ver `emergencia.md`.

Y una que no es de la lista pero aparece siempre: **el cliente pide
un "correo de olvidé mi clave"**. No está implementado y no es un bug: un correo de
reset es un camino de robo de cuentas esperando su flujo, y ese flujo tiene su
propio diseño y su propia auditoría (`aud_login`). Hasta que exista, el camino es
el panel o `npm run resetear:clave`.
