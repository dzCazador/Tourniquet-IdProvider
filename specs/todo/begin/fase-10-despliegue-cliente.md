# Fase 10 — Despliegue en un cliente: runbooks e instalación

**Estado:** ⬜ Pendiente
**Depende de:** [09](fase-09-endurecimiento.md) (o de la 07, si el cliente no pidió endurecimiento)
**Repo:** ninguno (es documentación + scripts); el DDL de las bases de negocio lo ejecuta el
usuario
**Requiere acción del usuario:** **sí** — es casi enteramente acción suya
**Riesgo:** medio — un despliegue mal hecho deja al cliente sin login
**Reversible:** sí, si el runbook de rollback existe (esa es la razón de la fase)
**Spec normativo:** `specs/00-arquitectura.md` D3, `specs/02` §5, `estetica-tourniquet.md` §11
**Mapa:** `specs/04-fases.md` Fase 04 (la parte que es del cliente)

---

## Por qué es una fase y no un anexo

Hasta la 09 todo se probó en desarrollo, contra `tourniquet_dev` y `rhpro_marcelino`. Un despliegue
en un cliente cambia cuatro cosas que el desarrollo no ejercita: **HTTPS real** (el `issuer` con
`https` es requisito, no preferencia), el reloj del servidor, la política de contraseñas del
gestor de secretos, y el nombre/logo del cliente en el portal.

D3 de `specs/00` dice que la instalación es **una instancia por app/base**: donde va Chile sólo hay
base de Chile. Eso significa que el despliegue no es "copiar la base de un lado a otro", es
"generar la instalación de este cliente con sus URIs y su nombre".

Esta fase es la que convierte el repositorio en algo instalable por alguien que no lo escribió.

---

## Objetivo

Que un cliente se instale siguiendo runbooks, sin ayuda, y que quede documentado qué se hizo y
cómo se revierte.

---

## Alcance

**Entra:**

- `deploy/runbooks/instalacion.md`: de cero a login funcionando.
- `deploy/runbooks/backup-restore.md`: backup de la base de control y de la master key **por
  separado**.
- `deploy/runbooks/rollback.md`: cómo volver atrás de cada paso de la instalación.
- `deploy/runbooks/rotacion-claves.md`: el de la 9.2, si se hizo.
- `scripts/generar-instalacion.mjs`: genera la semilla de catálogo con los valores del cliente
  (código, nombre, dominios, base) sin escribir nada sensible.
- Configuración por cliente del tema (`cat_cliente.politica_json.tema`, `estetica-tourniquet.md` §11).
- Checklist de `.env` por cliente, con los valores **a completar** y los **a no tocar**.
- `docs/instalacion.md` orientado a un administrador de sistemas del cliente, no a un desarrollador.

**No entra:**

- Instalar Windows Server, SQL Server ni el servicio de Windows: eso es del cliente y va en su
  documentación; acá se da por supuesto que hay un SQL Server accesible con una base creada.
- Certificados: se documenta el requisito (certificado válido, `https`, que el reloj esté bien) y
  se deja la emisión en manos del cliente.
- Multi-cliente en una instancia: D3 dice una instancia por cliente. Una instancia con N clientes
  es un diseño distinto, no un flag.

---

## Tareas

### 1. `scripts/generar-instalacion.mjs`

Interactivo, escribe **un** archivo `.sql` nuevo y numerado (`deploy/sql/91-semilla-<cliente>.sql`):

```
?cat_aplicacion.codigo    rhpro
?cat_cliente.codigo       cervi
?cat_cliente.nombre       Cervecería Cervi
?origen auth             https://auth.cervi.com
?origen app              https://rhpro.cervi.com
?redirect_uri callback   https://rhpro.cervi.com/auth/callback
?base codigo             rhpro_cervi
?base nombre             rhpro_cervi
?icono app               <path a un SVG, opcional>
?tema                     gothic | austero
```

El script **no** escribe credenciales de base (van por `registrar-base.mjs`, que cifra) ni
usuarios (van por `alta-usuario.mjs`). Y **no** escribe en `tourniquet_dev` ni en producción: sólo
genera el archivo para que el usuario lo ejecute.

### 2. Checklist de `.env` del backend

```env
NODE_ENV=production
PORT=3001
DATABASE_URL=<la del cliente, con usuario de app y password del gestor de secretos>
TQ_ISSUER=https://auth.cervi.com          # https OBLIGATORIO en producción
TQ_MASTER_KEY=<del gestor de secretos del cliente>
ACCESS_TTL_MIN=15
TQ_ROTACION_HABILITADA=false
```

Reglas que se verifican al arrancar y **fallan con mensaje claro**:

- `TQ_ISSUER` https en producción (el discovery no anuncia un issuer http).
- `TQ_MASTER_KEY` presente, 32 bytes base64.
- `DATABASE_URL` sin el sufijo `tourniquet_dev` (si está, es la base de desarrollo, no la de
  producción).
- `NODE_ENV=production` sin `DEBUG`.

### 3. Checklist de `.env` de RHPro (el cliente lo configura)

`AUTH_MODO=dual` (o `idp` si hay fallback local obligatorio), `TQ_ISSUER`, `TQ_AUDIENCE=rhpro`,
`TQ_TENANT=cervi`. Más el DDL de `user_per.idp_sub` ejecutado en la base de negocio **del
cliente**, con su variante `.mysql.sql` si el cliente usa MySQL (política del repo RHPro).

### 4. `runbooks/instalacion.md`

Orden exacto, con el comando o el archivo en cada paso:

1. Requisitos verificados: SQL Server accesible, base creada y vacía, DNS del `issuer` apuntando al
   backend, certificado instalado, **reloj del servidor sincronizado** (NTP).
2. Desplegar `backend` (`npm ci && npm run build`, servicio Windows o systemd).
3. `sqlcmd -i deploy/sql/00-crear-base.sql` contra el servidor (crea la base y el esquema).
   Alternativa si el DBA prefiere otro orden: `00-crear-base.sql` y despues los incrementales
   `01-*.sql` en orden. Los dos caminos dan el mismo esquema (`deploy/README.md`).
4. Generar la master key: `scripts/generar-clave.mjs` → al gestor de secretos del cliente. **Nunca**
   al `.env` del servidor en texto plano, nunca a un archivo de texto en el escritorio.
5. Aplicar la semilla del cliente generada en el punto 1.
6. Registrar la base de negocio: `scripts/registrar-base.mjs` (cifra la credencial).
7. Crear el primer admin: `scripts/bootstrap-admin.mjs`.
8. Desplegar el portal (export estático) en el servidor web que sirve el `issuer`.
9. Habilitar el acceso del admin a la app: `scripts/alta-usuario.mjs` + `UPDATE user_per SET
   idp_sub = ...` (SQL que corre el usuario).
10. Configurar `AUTH_MODO=dual` en RHPro y **probar el login local** antes de seguir.
11. Prueba de humo (abajo).
12. Entregar credenciales de emergencia y anotarlas en el runbook de emergencia.

### 5. Prueba de humo de instalación

La lista mínima que tiene que pasar **en la máquina del cliente**, con el cliente mirando:

1. El discovery responde por https y el `issuer` coincide con el dominio configurado.
2. El JWKS responde y expone una clave activa.
3. El admin del bootstrap entra al portal.
4. La lista de apps muestra la app del cliente con su nombre (no con el de desarrollo).
5. El deep-link entra a la app y crea sesión.
6. Logout de app y logout central, por separado.
7. Login local de RHPro funciona con `AUTH_MODO=dual` (probado **con Tourniquet apagado**).
8. Un usuario no habilitado recibe 401.
9. El panel admin lista los usuarios del cliente y ninguno de otro.
10. Backup de la base de control hecho y **restore probado** en una base aparte.

### 6. `runbooks/backup-restore.md`

El punto que más se olvida y el que más caro sale:

- **La base de control** se respalda con un plan de SQL Server (full semanal, diferencial diario,
  log cada 15 min si el cliente lo pide).
- **La master key se respalda en otro lugar.** Si se pierde, no hay restore posible: hay que
  regenerar `tok_clave_firma` y volver a cifrar todas las credenciales de bases. El runbook dice
  dónde se guarda y quién la tiene.
- **El restore se prueba, no se supone.** Al menos una vez, en una base vacía, restaurando el
  backup y ejecutando la prueba de humo contra esa copia. Un backup no probado no es un backup.

### 7. `runbooks/rollback.md`

Por cada paso de la instalación, cómo se vuelve atrás. Los casos que importan:

| Situación | Rollback |
|---|---|
| El portal no levanta | Volver al export anterior (si se guardó); si no, redeploy |
| La app no acepta el token | `AUTH_MODO=local` en RHPro y reinicio: el cliente vuelve a su login local |
| El IdP quedó configurado mal en `cat_aplicacion` | Corregir el registro (SQL) y recargar; el portal lee del registro en cada request |
| La base de control hay que reconstruirla | Restore del backup + los `.sql` de esquema |
| Un usuario quedó bloqueado | `UPDATE idn_usuario SET intentos_fallidos=0, bloqueado_hasta=NULL WHERE usuario=...` (SQL del usuario, auditado) |

El caso "la app no acepta el token" es el importante: `AUTH_MODO=local` es la red de seguridad de
todo el despliegue, y por eso la Fase 00 existe.

### 8. Tema por cliente

Si el cliente no quiere el tema gótico: `politica_json.tema = '{"estetica":"austero","color_acento":"#..."}'`
en `cat_cliente`, y el front lee ese valor. Los tokens de la paleta se sobreescriben en runtime; los
componentes no se tocan (`estetica-tourniquet.md` §11).

El **nombre del cliente** aparece en el portal (el anillo lleva el nombre, o las iniciales del
cliente). Un IdP que muestra "Tourniquet" a un empleado del cliente es raro; el nombre del cliente
es lo que corresponde.

---

## Criterios de aceptación

- [ ] La instalación se ejecutó **completa en una máquina limpia** siguiendo sólo
      `runbooks/instalacion.md`, sin ayuda. Si hizo falta preguntar algo, ese algo va al runbook.
- [ ] La prueba de humo (10 puntos) pasó entera.
- [ ] El servicio de Windows reinicia solo tras un reinicio del servidor (service recovery en
      `restart on failure`), verificado.
- [ ] `TQ_ISSUER` en https; el discovery no devuelve nada en http.
- [ ] La semilla del cliente se generó con `generar-instalacion.mjs` y **no** contiene credenciales
      ni usuarios.
- [ ] La master key está en el gestor de secretos del cliente y **no** en el `.env` del servidor en
      texto plano (verificado mirando la configuración real, no la del repo).
- [ ] El backup de la base de control existe y **el restore se probó** en una base aparte, con la
      prueba de humo contra la copia.
- [ ] El runbook de emergencia dice cómo entrar sin Tourniquet: usuario de emergencia de RHPro
      (Fase 00), dónde están sus credenciales y bajo qué condiciones se usa.
- [ ] El runbook de rollback cubre los 5 casos de la tabla, y el caso `AUTH_MODO=local` se probó
      **realmente** (Tourniquet apagado).
- [ ] El nombre del cliente aparece en el portal; el tema es el que el cliente eligió.
- [ ] Se entregó la lista de "no hecho" (`fase-09` §9.5) al responsable del cliente.
- [ ] `deploy/` no tiene ningún `.sql` con una credencial en claro.

---

## Seguridad

| Invariante | Aplicación |
|---|---|
| `https` obligatorio en producción | Verificado al arrancar: `TQ_ISSUER` http ⇒ el proceso no levanta |
| Master key en el gestor de secretos, no en el servidor | Checklist y verificación explícita; el runbook lo dice dos veces |
| Usuario SQL de la app con permisos mínimos | Login de aplicación: SELECT/INSERT/UPDATE sobre `cat_*` / `idn_*` / `tok_*` / `aud_*`; sin ALTER ni DROP en producción |
| Cuentas de emergencia documentadas | Quién las tiene, dónde, cuándo se usan. Con log de cada uso |
| Nada de secretos en `deploy/` | Ni en las semillas, ni en los runbooks, ni en ejemplos |
| DDL de las bases de negocio lo ejecuta el cliente | El agente entrega el `.sql`; no lo corre |

## Trampas

1. **El reloj del servidor.** Es el fallo que más tiempo cuesta en un despliegue OIDC: con el reloj
  adelantado, todos los tokens "expiran en el futuro" y la app los rechaza con un mensaje que no
   apunta a la causa. La verificación del reloj es el paso 1 del runbook, no una nota al pie.
2. **El certificado y el nombre del `issuer`.** El `issuer` es el **string** que las apps comparan.
   Si el certificado sirve `auth.cervi.com` pero el `TQ_ISSUER` dice `https://auth.cervi.com/`
   (con barra) o `https://www.auth.cervi.com`, el discovery y el token no coinciden y **todas** las
   apps dan 401. Se copia y pega el mismo string, sin "corregirlo".
3. **Habilitar `idp_sub` en la base de producción sin probar el login local primero.** Si el
   `UPDATE` queda a medias, el usuario existe en el IdP y en `user_per` con un `sub` distinto del
   que tiene el token, y no entra a ninguna parte. El orden del runbook pone el login local (paso
   10) antes del `idp_sub` (paso 9)... al revés: primero se verifica que el login local funciona con
   `AUTH_MODO=local`, **después** se pasa a `dual`. Ese orden es intencional.
4. **La base de control sin backup y con la master key en la máquina.** Si el servidor de base se
   cae el día 1, se pierde la identidad de toda la empresa. El backup es del runbook, no del
   afterthought.
5. **Instalar la semilla de desarrollo.** Si se corre `90-semilla-catalogo.sql` (con el
   `localhost` en `redirect_uris_json`) en el cliente, ese `localhost` queda como `redirect_uri`
   válido para siempre. El runbook dice explícitamente: usar la semilla **generada** para el
   cliente, nunca la de desarrollo.
6. **No probar el camino de emergencia.** Un despliegue donde el único acceso es por Tourniquet y
   Tourniquet está caído no tiene salida. La prueba 7 de la prueba de humo (con Tourniquet apagado)
   no es opcional.
