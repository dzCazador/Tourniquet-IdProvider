# Runbook — Rotación de las claves de firma

Qué rota: la clave RSA con la que el IdP **firma** los access tokens
(`tok_clave_firma`). La publica es el JWKS (`/.well-known/jwks.json`), y es la
única que las apps necesitan: el `kid` viaja en el header de cada token
(`specs/01` §5).

- **Política:** cada **90 días**, o de inmediato si se sospecha que la clave se
  filtró. 90 días es una decisión de diseño, no un default: está en
  `DIAS_ROTACION` (`backend/src/claves/firma.service.ts`) y en `specs/01` §5.
- **Ventana de solapamiento:** 24 h. La clave nueva entra en el JWKS **antes** de
  firmar con ella, y la anterior sale 24 h después de que la nueva empiece a
  firmar.
- **Rollback:** reactivar la clave anterior. Es seguro dentro de esa ventana de
  24 h y fuera de ella.

> **La rotación es de la instalación, no de un cliente.** El JWKS es único: rotar
> afecta los tokens de todos los clientes. Por eso **no** es un endpoint de
> `/admin/*` (panel de un tenant) sino de `/operacion/claves`, protegido por
> `TQ_ROTACION_HABILITADA` + `TQ_OPERADORES_CLAVES` (`specs/01` §5.1).

---

## Los dos caminos

| Camino | Cuándo | Cómo |
|---|---|---|
| **Script** (el del runbook) | Siempre. Es el procedimiento normal | `npm run rotar:clave -- --rotar` |
| **Endpoint HTTP** | Instalaciones que quieren automatizarlo, y el **drill** | `TQ_ROTACION_HABILITADA=true` + `TQ_OPERADORES_CLAVES=...` |

Con la variable apagada (el default), `/operacion/claves` responde **404**: el
endpoint no existe, y no hay forma de que alguien lo descubra probando.

---

## Procedimiento (5 pasos)

Cada uno tiene su comprobación. **No se da por terminada una rotación hasta que
el paso 5 pasa**: una rotación que nadie probó se descubre durante un incidente
(trampa 3 de `fase-09`).

### Antes: mirá el estado

```bash
npm run rotar:clave          # sin flags: NO cambia nada, solo informa
```

Anotá el `kid` activo y la fecha. Ese `kid` es el que hay que guardar para poder
revertir.

### 1 · Generar y activar la clave nueva

```bash
npm run rotar:clave -- --rotar
# (o, con el endpoint: POST /operacion/claves/rotar)
```

Imprime el `kid` anterior y el nuevo. Desde este momento:
- Los tokens **nuevos** se firman con la clave nueva.
- La clave anterior queda con `retirada_en = ahora` y **sigue publicada 24 h**.

### 2 · Verificar el JWKS: aparecen las DOS claves

```bash
curl -s https://<issuer>/.well-known/jwks.json | jq '.keys[].kid'
# o, sin jq:
curl -s https://<issuer>/.well-known/jwks.json
```

Tiene que devolver los dos `kid`. Si devuelve uno solo, **pará**: o la clave
anterior no estaba activa (nunca hubo rotación), o el JWKS está cacheado en
algún proxy.

> El IdP memoiza el JWKS 60 s en memoria y anuncia `Cache-Control: max-age=300`,
> así que la propagación a `/userinfo` tarda hasta un minuto (`specs/01` §5).
> Las **apps** cachean 24 h y refrescan solas ante un `kid` desconocido
> (una vez por token, acotado a una vez cada 30 s).

### 3 · Verificar que un token nuevo lleva el `kid` nuevo

Entrá al portal y pedí un token (el inspector de `/dev/token` sirve, en
desarrollo). El header tiene que traer el `kid` nuevo:

```bash
npm run verificar:rotacion -- --token eyJhbGciOi...
```

Ese comando valida el token contra el JWKS actual y dice con qué clave se firmó,
si esa clave sigue publicada y cuánto le queda de vida.

### 4 · Entrar de verdad a una app

Este es el paso que no se saltea: **un login completo contra una app configurada
con este `TQ_ISSUER`**, hasta ver los datos de la persona. Si la app falla con
`kid desconocido` después de 30 segundos, es un problema de caché de la app, no
del IdP, y hay que forzar el refresco de su JWKS (`POST /auth/rotate-jwks` en
RHPro, `specs/03`).

### 5 · Esperar la ventana y cerrar

24 h después de la rotación, la clave anterior sale del JWKS sola (por fecha, no
por un paso). Los tokens que hop firmara con ella expiraron a los 15 min, así
que a partir de ahí no queda nada firmado con una clave que no está publicada.

```bash
npm run verificar:rotacion      # tiene que decir TODO OK
```

Anotá en el acta de la instalación: fecha, `kid` anterior, `kid` nuevo, y el
resultado del paso 4.

---

## Rollback

**Si algo falla antes del paso 4**, lo más rápido es volver atrás:

```bash
npm run rotar:clave -- --reactivar <kid-anterior> --si
# (o: POST /operacion/claves/reactivar  {"kid": "<kid-anterior>"} )
```

Eso vuelve a poner la clave anterior como activa y retira la nueva. **Dentro de la
ventana de 24 h** los tokens ya emitidos siguen valiendo: la clave volvió al
JWKS.

**Después de la ventana** reactivar una clave vieja ya no recupera los tokens que
esa clave firmó y que el JWKS dejó de publicar, pero **sí** deja de firmar con
la clave que el operador dio por comprometida, que es el motivo por el que se
reacciona. Lo que queda pendiente es reemitir el ingreso de los usuarios
afectados.

**Las claves no se borran nunca.** Por eso reactivar funciona: la fila está.

---

## Si se sospecha que la clave se filtró

Es el caso urgente, y la diferencia con la rotación de rutina es **el orden**:

1. **Rotar primero, verificar después.** No hay nada que esperar "a que
   nadie esté mirando": la clave filtrada está firmando tokens ahora mismo.
2. Con la clave nueva activa, la vieja sale del JWKS a las 24 h. Si la
   compromete fue efectiva, se puede **reactivar el mismo procedimiento de
   rollback para acortar la ventana**... salvo que eso también esté comprometido.
3. **Revocar las sesiones** de los usuarios del cliente afectado desde el panel
   (`DELETE /admin/sesiones/:sid`): un token de acceso vivo firmado con la clave
   filtrada sigue siendo criptográficamente válido hasta 15 minutos aunque la
   clave ya no esté publicada — por eso el paso 4 de una rotación de rutina
   **no** alcanza en el caso de compromiso.
4. Registrar el incidente en `aud_login`: el evento de la rotación queda con el
   `idusuario` del operador (`op_rotacion_claves`).

> Un token robado de la base **no** se puede "dar de baja" sin tocar sesiones: la
> firma es válida y el token expira solo. Por eso el control real es la
> revocación por `sid`, no la rotación.

---

## Rotación de la master key (NO es lo mismo)

`TQ_MASTER_KEY` cifra las claves privadas, los secretos de MFA y las credenciales
de las bases (`specs/01` §6). **No se rota** con este procedimiento: no hay
generación en caliente.

Si hay que cambiarla, es un incidente de otro tipo: hay que regenerar
`tok_clave_firma` y volver a cifrar **todas** las credenciales de
`cat_base_datos` y todos los secretos de MFA. No hay procedimiento en este repo
y no se improvisa: es la Fase 10 (instalación) con el runbook de backup.

Por eso la master key vive en el gestor de secretos del cliente y **no** en un
`.env` del servidor, y por eso el runbook de backup dice dónde está y quién la
tiene, en vez de "en un lugar seguro".

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run rotar:clave` | Estado de las claves. No cambia nada |
| `npm run rotar:clave -- --rotar` | Rota, con confirmación escrita `ROTAR` |
| `npm run rotar:clave -- --rotar --si` | Rota sin preguntar (pipelines) |
| `npm run rotar:clave -- --reactivar <kid>` | Rollback, con confirmación `REACTIVAR` |
| `npm run verificar:rotacion` | Comprueba estado, JWKS y ventana de 24 h |
| `npm run verificar:rotacion -- --token <jwt>` | Además valida ese token real |

Todos leen el mismo `.env` de la raíz que la app, y necesitan la
`TQ_MASTER_KEY`: sin ella no pueden descifrar la clave privada para firmar (el
script de estado y el de verificación **no** necesitan descifrar, y por eso
siguen funcionando con la master key equivocada: es lo primero que hay que
comprobar si "la rotación no firma").
