# Instalación de Tourniquet — guía del administrador de sistemas

Para el **administrador de sistemas del cliente**, no para un desarrollador. No
hace falta saber Nest, OIDC ni SQL Server en detalle: hace falta saber
administrar Windows (o Linux), un servidor SQL y un servidor web.

El procedimiento completo, con el "por qué" de cada paso, está en
**`deploy/runbooks/instalacion.md`**. Esta es la versión corta, en orden de
ejecución.

---

## Qué se instala y dónde

Un despliegue de Tourniquet son **cuatro cosas en tres máquinas**:

| # | Qué | Dónde | Qué hace |
|---|---|---|---|
| 1 | **El portal** | Servidor web (estático) | La pantalla de ingreso y el lanzador de aplicaciones. Son archivos: HTML, CSS, JS. **No hay que instalar nada** |
| 2 | **El backend** | El mismo servidor, con Node.js | El sistema de identidad. Valida usuarios y emite los tokens de ingreso |
| 3 | **La base de control** | SQL Server del cliente | Quién existe, qué aplicaciones hay y quién entra a qué |
| 4 | **Los certificados** | El servidor web y el del backend | El candado del candado |

> **Un cliente, una instalación.** Si el cliente tiene dos bases de negocio en
> países distintos, son **dos instalaciones** —una por base—, no una instalación
> con dos bases. Es una decisión de diseño, no una limitación.

---

## Requisitos del cliente

| Requisito | Detalle |
|---|---|
| **Windows Server** (o Linux) con Node.js 20 o superior | Cualquiera de los dos. Los comandos de los runbooks están en Windows porque es el despliegue de referencia |
| **SQL Server 2019 o superior** | También la versión Express (que no tiene Agente: ver `jobs-limpieza.md`) |
| **Un dominio con certificado válido** | El del sistema de identidad, por ejemplo `https://acesso.cervi.com`. **La emisión del certificado es del cliente** |
| **Permisos para crear un usuario de SQL de aplicación** | El DBA lo otorga, con los permisos mínimos de `instalacion.md` §3 |
| **Un gestor de secretos** | Donde va la llave maestra (§5) |

---

## Orden de ejecución

Cada paso tiene su detalle en el runbook. Acá está el orden y el "¿listo?" de cada
uno.

### 1 · Verificar el reloj del servidor

**Lo primero, antes que nada.**

Es el paso que más tiempo cuesta cuando sale mal. Con el reloj del servidor
adelantado, **todos** los usuarios quedan afuera y el mensaje que ven ("sesión
inválida") no dice que el problema es la hora.

```powershell
w32tm /query /status
```

Tiene que decir que la fuente es un servidor NTP y que la última sincronización
fue hoy.

**¿Listo cuando?** El `Last Successful Sync Time` es de hoy y no es de hace tres
días.

### 2 · Desplegar el backend

```bash
npm ci
npm run build
```

Después, registrarlo como **servicio de Windows** (o como unidad de `systemd`), con
**reinicio automático ante falla** y con la cuenta de servicio del cliente, que
tiene que tener los permisos mínimos.

**¿Listo cuando?** El servicio está en `auto` y se levanta solo después de reiniciar
la máquina.

### 3 · Completar la configuración

Un solo archivo (`.env`) y el gestor de secretos. Lo importante:

| Variable | Cómo va en un cliente |
|---|---|
| `TQ_ISSUER` | **Exactamente** el dominio con `https`, sin barra al final, sin `www` |
| `TQ_MASTER_KEY` | Del gestor de secretos, **nunca** escrita en el archivo |
| `DATABASE_URL` | La base del cliente, con su usuario de aplicación |
| `NODE_ENV` | `production` |

**¿Listo cuando?** El servicio arranca. Si no arranca, **lee el mensaje**: el
programa chequea cuatro cosas al arrancar y dice exactamente cuál falló. No es un
error de configuración genérico.

### 4 · Crear la base de datos

```bash
sqlcmd -S <servidor> -U sa -P <clave> -b -i deploy/sql/00-crear-base.sql
```

Un archivo. Crea las 14 tablas con sus índices.

**¿Listo cuando?** `deploy/sql/99-verificar-esquema.sql` imprime la estructura y no
da errores. Guardar esa salida: es la huella de referencia para comparar después.

### 5 · Generar y guardar la llave maestra

```bash
npm run generar:clave
```

**Copia de seguridad de esa llave: obligatoria, antes de seguir.** No tiene copia
ni recuperación posible. Si se pierde, no hay forma de volver atrás: hay que
regenerar las claves de firma de todos los tokens y volver a cifrar todas las
contraseñas de las bases. Ver **`deploy/runbooks/backup-restore.md`**.

**¿Listo cuando?** La llave está en el gestor de secretos del cliente, **y** hay una
segunda copia en un sistema distinto, y hay un nombre de persona escrito de quién
tiene acceso.

### 6 · Cargar los datos del cliente

```bash
npm run generar:instalacion    # genera deploy/sql/91-semilla-<cliente>.sql
sqlcmd -S <servidor> -U sa -P <clave> -d tourniquet -b -i deploy/sql/91-semilla-<cliente>.sql
```

Carga: la aplicación (por ejemplo RHPro), el cliente (por ejemplo Cervecería Cervi)
y el inventario de la base de negocio. **Sin** usuarios, **sin** contraseñas y
**sin** claves.

**¿Listo cuando?** El archivo termina con cinco verificaciones que tienen que dar
`0`. Una de ellas revisa que no haya quedado ningún `localhost` en la lista de
destinos de autorización — es un detalle de seguridad, no de limpieza.

### 7 · Registrar la base de negocio

```bash
npm run registrar:base
```

Pide el usuario y la contraseña de la base de negocio del cliente, y los guarda
**cifrados** (AES-256-GCM). El archivo `.sql` no los lleva: una contraseña escrita
en un archivo de texto es una contraseña escrita en cualquier lado.

**¿Listo cuando?** El inventario muestra la base con credencial cifrada y no con la
marca `sin_registrar`.

### 8 · Crear el primer administrador

```bash
npm run bootstrap:admin
```

**Un solo administrador.** Alguien que administer los accesos, no el dueño de la
empresa. Y **no** la misma cuenta de todos: cada persona con su propio usuario, por
auditoría.

**¿Listo cuando?** La persona puede entrar al panel.

### 9 · Desplegar el portal

```bash
cd frontend
NEXT_PUBLIC_API_URL=https://<dominio-del-idp> npm run build
```

Copiar `frontend/out/` al servidor web.

**¿Listo cuando?** Se abre `https://<dominio>/login` y aparece la pantalla de
ingreso **con el nombre de la empresa**. Si aparece "Tourniquet" en lugar del
nombre del cliente, o la página sale en blanco, el `NEXT_PUBLIC_API_URL` no era el
correcto.

Las cabeceras de seguridad que tiene que servir el servidor web están en
`instalacion.md` §10. **Son obligatorias**, no opcionales: sin `connect-src` el
portal no puede iniciar sesión, y sin `Strict-Transport-Security` el navegador
deja iniciar sesión en http.

### 10 · Probar el ingreso

Diez pruebas, en la máquina del cliente y con el cliente mirando. Están en
`instalacion.md` §12.

Las **tres que importan** para el administrador de sistemas:

1. `curl https://<dominio>/.well-known/openid-configuration` responde, y el
   `issuer` que devuelve es **idéntico** al configurado.
2. El ingreso funciona en un navegador común (Chrome o Edge del Windows del
   cliente), y no solo en el navegador de desarrollo.
3. **El ingreso local de RHPro funciona con Tourniquet apagado.** Este es el que
   garantiza que, si el sistema de identidad se cae, la empresa puede seguir
   trabajando.

### 11 · Probar el respaldo

Restaurar el respaldo en una base vacía y probar el ingreso contra esa copia.

**Un respaldo que no se probó no es un respaldo**, es un archivo con una fecha.
El procedimiento completo en `deploy/runbooks/backup-restore.md`.

### 12 · Entregar

Dejar por escrito, en el acta de instalación:

- El dominio exacto del sistema de identidad.
- Dónde está la llave maestra y quién la tiene.
- Cuándo se hizo el primer respaldo y dónde se probó la restauración.
- Quién tiene la cuenta de emergencia y dónde están sus credenciales
  (`deploy/runbooks/emergencia.md`).
- Qué quedó sin instalar, y por qué.

---

## Resumen para el cliente

**Tourniquet** centraliza el ingreso: una sola cuenta y una sola clave para todas
las aplicaciones (por ahora, RHPro). Cada aplicación sigue decidiendo **qué** puede
ver cada persona: eso no cambia.

**Lo que el usuario ve** es una pantalla de ingreso con el nombre de su empresa, y
después un lanzador con las aplicaciones a las que tiene acceso.

**Lo que el administrador de sistemas tiene que saber:**

| | |
|---|---|
| Dónde se guarda la información de usuarios | La base de datos del cliente, `tourniquet`. No sale del servidor |
| Qué pasa con las contraseñas de los usuarios | Se guardan cifradas con un algoritmo de un solo sentido (argon2id). Ni el propio Tourniquet puede leerlas |
| Cuánto duran las sesiones de ingreso | 7 días con renovación automática, o cierre inmediato desde el panel |
| Qué pasa si alguien olvida su clave | Un administrador del panel le cambia la clave. **No hay "olvidé mi clave" por correo** |
| Cuántos intentos fallidos antes de bloquearse | 5, y después hay que esperar |
| Si se pueden ver las contraseñas de los usuarios | No. Y las de las bases de negocio, tampoco: están cifradas |
| Qué se guarda de cada intento de ingreso | Usuario, fecha, dirección IP y resultado. **No se borra** (se conserva 2 años) |

---

## Cuando algo falla

| Síntoma | Lo primero que hay que mirar |
|---|---|
| Todos los usuarios están afuera y el mensaje es "sesión inválida" | **El reloj del servidor.** Siempre primero |
| El portal no muestra el nombre de la empresa | `NEXT_PUBLIC_API_URL` en el momento del build. El build corta si falta, pero no si apunta al lugar equivocado |
| El ingreso entra y al recargar pide la clave otra vez | La cookie de sesión: si el portal y el sistema de identidad están en dominios distintos, hace falta `SameSite=None; Secure` |
| El navegador dice que la página no es segura | El certificado. **Emisión del cliente** |
| La base de datos no conecta | ¿Está el servicio de SQL Server? ¿Hay espacio en disco? ¿El usuario de aplicación sigue teniendo permisos? |
| Nadie puede entrar y Tourniquet está caído | `deploy/runbooks/emergencia.md` |
