# Runbook — Rollback de la instalación

Por cada paso de `instalacion.md`, cómo se vuelve atrás. El criterio es siempre el
mismo: **dejar al cliente como estaba antes de que empezáramos**, sin dejar datos a
medias y sin que nadie quede afuera.

Orden de decisión, antes que cualquier tabla:

> **¿El cliente tiene gente adentro con Tourniquet?**
>
> - **No** → freely reversible. Se puede deshacer cualquier paso en cualquier
>   orden.
> - **Sí** → el rollback tiene dos tiempos: **dejar de romper** y **deshacer**. La
>   fila 2 de la tabla de abajo es la que se toca primero, y mientras haya gente
>   adentro, **cualquier cambio pasa por la fila 2 primero**.

---

## La tabla

| # | Situación | Qué hacer | Qué le cuesta al cliente |
|---|---|---|---|
| 1 | **El portal no levanta** (el export está roto, falta `NEXT_PUBLIC_API_URL`, el web server no sirve) | Volver al export anterior si se guardó; si no, `NEXT_PUBLIC_API_URL=https://<issuer> npm run build` y volver a copiar `out/` | Nada: el login por Tourniquet no funcionaba |
| 2 | **La app no acepta el token** (el `issuer` quedó mal, el `kid` no coincide, el `redirect_uri` no cuadra) | **`AUTH_MODO=local` en RHPro y reiniciar.** El cliente vuelve a su login local en el momento. Después, diagnóstico con el cliente adentro en el sistema | **Nada**, si la fila 2 se aplica primero |
| 3 | **El IdP quedó configurado mal en `cat_aplicacion`** (un `redirect_uri` que sobra, un origen, una `url_inicio`) | `UPDATE` a la fila y recargar. El authorize lee el registro en cada request: no hay caché que invalidar ni que reiniciar | Depende de qué esté mal |
| 4 | **La base de control hay que reconstruirla** | Restore del backup + los `.sql` de esquema. Ver `backup-restore.md` §4, que avisa de lo que pasa con la clave de firma | **Alto**, y es una ventana de mantenimiento |
| 5 | **Una persona quedó bloqueada** (cinco intentos, o la bloquearon por error) | `npm run resetear:clave`, o el SQL de abajo | Nada |
| 6 | **Una persona existe en el IdP y en `user_per` con un `sub` distinto** | `UPDATE user_per SET idp_sub = ...` con el `sub` real, o dejarlo sin `idp_sub` para que entre por login local | Nada, si el login local está probado |
| 7 | **La master key se filtró o se perdió** | Ver `backup-restore.md` §2. **No hay procedimiento corto** | Muy alto: hay que regenerar claves de firma y recifrar credenciales |

---

## Fila 2, la que importa: `AUTH_MODO=local`

**Es la red de seguridad de todo el despliegue**, y por eso la Fase 00 existe.

```env
# En el .env de RHPro del cliente.
AUTH_MODO=local
```

Reiniciar RHPro. A partir de ese momento, **toda** la gente entra con su login local
y ninguno depende de Tourniquet. Tourniquet puede seguir caído, con un
`redirect_uri` mal o con la base sin master key: **no afecta a nadie**.

Cuándo se aplica:

- La app rechaza el token y no se sabe por qué.
- El discovery o el JWKS no responden.
- Hay que tocar `cat_aplicacion` o `cat_cliente` y no se quiere que nadie esté
  adentro mientras tanto.
- Cualquier incidente donde la duda sea "esto es Tourniquet o es otra cosa".

Volver a `dual`:

```env
AUTH_MODO=dual
```

Y **volver a probar el punto 7 de la prueba de humo** antes de dar por cerrado.

> **Un despliegue sin login local probado no tiene rollback.** El `AUTH_MODO=local`
> funciona sin Tourniquet, pero necesita un login local que funcione, y eso se
> verifica **con Tourniquet apagado** (`instalacion.md` §12, punto 7). Un
> `AUTH_MODO=local` "que debería funcionar" es un supuesto, y un supuesto en el
> camino de emergencia es un camino de emergencia que no existe.

---

## Fila 5: desbloquear a una persona

```bash
npm run resetear:clave -- --listar          # intentos, bloqueos, estado
npm run resetear:clave -- --usuario jsmith  # cambiar la clave de una persona
```

El script pide la clave por prompt, valida la misma política mínima que el alta,
limpia el contador y **cierra las sesiones vivas de esa persona en todos los
clientes**. Ese último paso es el que lo hace una reset de verdad y no un trámite:
cambiarle la clave y dejarlo adentro con un refresh de 7 días no habría cambiado
nada.

Si **no** se quiere cambiar la clave y solo levantar el bloqueo (la persona sabe la
suya, se bloqueó a sí misma con cinco intentos), el SQL lo corre el usuario, y queda
auditado:

```sql
UPDATE dbo.idn_usuario
SET intentos_fallidos = 0, bloqueado_hasta = NULL
WHERE usuario = N'jsmith';
```

> Un usuario **con historial de auditoría no se borra nunca** desde la app:
> `aud_login.idusuario` es `ON DELETE NO ACTION` a propósito. En una instalación
> real, una persona que se va **se deshabilita** (`estado = 'inactivo'`), no se
> borra. La auditoría no se borra desde código de negocio (invariante de
> `AGENTS.md`).

---

## Fila 3: corregir `cat_aplicacion`

El `authorize` lee el catálogo **en cada request**: no hay caché, no hay servicio
que reiniciar, no hay deploy. El cambio se ve en el request siguiente.

```sql
-- Agregar un redirect_uri. Solo el origen nuevo, nunca un patron.
UPDATE dbo.cat_aplicacion
SET redirect_uris_json = N'["https://rhpro.cervi.com/auth/callback"]'
WHERE codigo = N'rhpro';

-- Verificar antes de seguir: esto imprime lo que las apps van a comparar.
SELECT codigo, redirect_uris_json, origenes_json, url_inicio
FROM dbo.cat_aplicacion WHERE codigo = N'rhpro';
```

Después: **recargar la página de login en el navegador**. El `redirect_uri` se
compara contra el parámetro de la petición, y una pestaña con el formulario viejo
manda el viejo.

### Un `redirect_uri` que sobra es un agujero, no una molestia

Quitar un `redirect_uri` **arregla** algo y **no** rompe a nadie: nadie depende de
que su callback esté en la lista. Agregar uno es al revés: expone un destino
nuevo de códigos de autorización. Por eso la revisión de `redirect_uris_json` es
obligatoria antes de entregar (`instalacion.md` §6, verificación de la semilla), y
por eso el `localhost` de la semilla de desarrollo es un problema de seguridad y
no de limpieza (`specs/01` §9).

---

## Fila 4: reconstruir la base de control

Solo cuando la base está realmente rota. Es un acto de mantenimiento:

1. **Avisar al cliente.** Es una ventana en la que nadie entra.
2. Restaurar el backup más reciente **en otro nombre** (`tourniquet_restore`), no
   sobre la de producción. Ver `backup-restore.md` §3.
3. Correr `99-verificar-esquema.sql` y comparar con `huella_instalacion.txt` (el
   del acta). Si difieren, aplicar los incrementales que falten, en orden.
4. Pruebas de humo **contra la copia**, con la master key.
5. Recién ahí, apuntar el servicio a la base restaurada y reiniciar.
6. **La clave de firma retrocedió** si el backup es anterior a la última rotación:
   las sesiones abiertas se caen y hay que refrescar el JWKS cacheado en las apps
   (`POST /auth/rotate-jwks` en RHPro). Es esperado, está anotado en
   `backup-restore.md` §4, y no se cuenta como incidente.
7. Probar los diez puntos de `instalacion.md` §12 contra la base nueva.

---

## Fila 7: la master key

**No hay rollback.** Y no lo hay por una razón técnica, no por falta de
procedimiento: AES-256-GCM no permite distinguir "cifrado con la clave correcta" de
"cifrado con cualquier otra", así que sin la master key las columnas cifradas son
bytes y no hay forma de recuperarlas parcialmente.

Si **se filtró**:

1. Rotar la clave de firma de inmediato (`rotacion-claves.md`), **antes** de
   investigar: la clave filtrada está firmando tokens ahora mismo.
2. Revocar las sesiones vivas desde el panel (un token robado sigue siendo
   criptográficamente válido hasta 15 minutos, aunque la clave ya no esté en el
   JWKS).
3. **Cambiar la master key** y recifrar: claves de firma, secretos de MFA y
   credenciales de bases de negocio, uno por uno. Es un procedimiento largo, con
   su downtime, y **no está escrito** en este repo. Se escribe cuando pase, con un
   cliente mirando, o se llama a quien lo escribiera.
4. Auditar todo el que se hizo con la clave vieja.

Si **se perdió**: mismo camino desde el punto 3, y peor: no hay nadie al que
auditar. Por eso el paso 3 del `backup-restore.md` existe.

---

## El orden de deshacer una instalación a medio hacer

Si hay que **desinstalar** (el cliente cambió de decisión), de adentro hacia
afuera, y en este orden:

| # | Qué se deshace | Cómo | Por qué en este orden |
|---|---|---|---|
| 1 | El acceso de la gente | Deshabilitar en el panel, **no** borrar | Deshabilitar es reversible; borrar con auditoría no lo es |
| 2 | `AUTH_MODO=local` en RHPro | Dejarlo en `local` | Es el estado en el que el cliente **funcionaba antes** |
| 3 | El portal | Borrar el export | No se toca más nada que lo use |
| 4 | El backend | Parar el servicio | Con el portal borrado ya no hay quien lo llame |
| 5 | La credencial de la base de negocio | `npm run registrar:base` para vaciarla, o dejar la fila con el centinela | Se va al final porque mientras haya una sesión viva puede estar usándose |
| 6 | La base de control | **Dejarla.** Es el registro de que existió una instalación, y borrar la auditoría de una instalación que se deshizo es exactamente lo que `AGENTS.md` prohíbe | Un `DROP DATABASE` acá borra `aud_login` de todos los intentos de ingreso |

> **El paso 6 es el que más se discute y el que menos se cede.** Una
> instalación deshecha con auditoría borrada deja a la empresa sin registro de que
> hubo un IdP y de quién lo intentó. Se puede archivar la base entera y congelarla;
> lo que no se puede es borrarla.

---

## Lo que **no** tiene rollback

Para que quede escrito, porque son las tres cosas que alguien va a asumir que sí:

| Qué | Por qué no |
|---|---|
| **Una clave que cambió de una persona** | El hash argon2id es de un solo sentido. No hay vuelta atrás; la persona entra con la nueva |
| **Una sesión cerrada desde el panel** | `tok_sesion` se cierra, no se borra, y un refresh revocado se marca revocado. Cerrar es irreversible por diseño |
| **Un `aud_login` borrado** | Por los jobs de retención, a los 2 años, y solo así. Un borrado manual desde la app es un bug, no una operación |
