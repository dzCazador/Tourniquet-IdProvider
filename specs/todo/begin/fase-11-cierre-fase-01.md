# Fase 11 — Cierre de la Fase 01: acta de verificación y estado de la suite

**Estado:** ⬜ Pendiente
**Depende de:** [05](fase-05-registro-demo.md) como mínimo; idealmente todas
**Repo:** ninguno
**Requiere acción del usuario:** **sí** — correr la verificación completa y firmarla
**Riesgo:** nulo (es un acta, no código)
**Reversible:** N/A
**Spec normativo:** `specs/04-fases.md` Fase 01, completa
**Mapa:** `specs/04-fases.md` Fase 01 (cierre)

---

## Por qué existe esta fase

`specs/04-fases.md` es explícito: *"Ningún criterio de aceptación admite 'lo probé y anduvo' sin
registrar: se marca en la fila de la fase."* El repo no tiene tests automatizados (regla 1 de
`AGENTS.md`), así que la **única** garantía de que el IdP funciona es un registro escrito de
verificaciones hechas por una persona, con fecha y resultado.

Sin esta fase, "Tourniquet está hecho" es una opinión. Con ella, es un documento que dice qué se
probó, cuándo, con qué resultado, y qué queda pendiente.

---

## Objetivo

Dejar por escrito, con fecha y resultado, el estado de cada criterio de aceptación de la Fase 01
de `specs/04`, y decidir con nombre y apellido si la suite puede seguir a la Fase 02.

---

## Alcance

**Entra:**

- Corrida manual completa de los criterios de la Fase 01 de `specs/04` (los 9 listados ahí),
  mapeados uno a uno a las fases que los implementan.
- Un acta en `specs/todo/begin/acta-cierre-fase-01.md` con la tabla de resultados.
- El estado actualizado en el `README.md` de esta carpeta y en `specs/04-fases.md`.
- La lista de lo que quedó pendiente, si algo no pasó.

**No entra:**

- Arreglar lo que falle: esa corrección vuelve a su fase.
- La Fase 02 en sí: el acta es el veredicto, no el trabajo.

---

## Tareas

### 1. Corrida de criterios de `specs/04` Fase 01

Los nueve criterios del spec, con la fase que los respalda:

| # | Criterio de `specs/04` Fase 01 | Fase | Resultado | Fecha | Quién |
|---|---|---|---|---|---|
| 1 | `curl`-driven authorize→token→userinfo emite access con `sub`, `aud`, `tenant`, `sid` correctos | [03](fase-03-nucleo-oidc.md) | | | |
| 2 | Code usado 2 veces ⇒ `invalid_grant` + evento en auditoría | [03](fase-03-nucleo-oidc.md) | | | |
| 3 | Refresh reusado ⇒ revocación de la familia | [03](fase-03-nucleo-oidc.md) | | | |
| 4 | Logout mata la sesión y el siguiente refresh falla | [03](fase-03-nucleo-oidc.md) / [04](fase-04-portal-login.md) | | | |
| 5 | JWKS muestra el `kid` activo | [02](fase-02-identidad-y-claves.md) / [03](fase-03-nucleo-oidc.md) | | | |
| 6 | `npm run lint` verde en ambos proyectos | [01](fase-01-scaffold-control.md) | | | |
| 7 | La base de control es recreable de cero sólo con `deploy/sql/` | [01](fase-01-scaffold-control.md) | | | |
| 8 | Un `curl`-driven completo desde el discovery hasta userinfo | [03](fase-03-nucleo-oidc.md) | | | |
| 9 | El portal hace login real y el authorize sale del navegador | [04](fase-04-portal-login.md) / [05](fase-05-registro-demo.md) | | | |

Resultado posible: **OK**, **OK con observación**, **FALLA**. "OK con observación" tiene que
escribir la observación, no se deja en blanco.

### 2. Pruebas de invade que el spec no pide y conviene hacer igual

Estas no están en `specs/04` porque no son parte del contrato, pero cada una encontró un defecto
real en la historia de estos sistemas:

| Prueba | Qué busca | Resultado |
|---|---|---|
| Token con `alg=none` | Que el validador no confíe en el header | |
| Token HS256 firmado con un secreto inventado | Que nadie haya pasado a simétrico | |
| `redirect_uri` con un carácter más, otro esquema, `localhost` | Que la comparación sea exacta | |
| `code_verifier` que no corresponde al challenge | Que el PKCE se verifique de verdad | |
| Access de la app A usado en la app B | Que `aud` se valide | |
| `/userinfo` con un `sid` revocado pero JWT vigente | Que la revocación sea efectiva antes del `exp` | |
| Login con 6to intento seguido del correcto | Que el bloqueo aplique | |
| Usuario de un cliente en el lanzador de otro | Que el filtro de tenant esté | |
| Dos pestañas con dos apps distintas | Que la sesión no se pise | |
| El mismo `refresh` desde dos requests simultáneos | Que la rotación no acepte el doble canje | |

El último es interesante: es la condición de carrera de la rotación. Con `usado_en` seteado en la
misma transacción que el canje, el segundo request lee la fila ya usada y revoca la familia. Si el
`usado_en` se escribe **después** de emitir, hay una ventana en la que los dos canjean.

### 3. El acta

`specs/todo/begin/acta-cierre-fase-01.md`, con:

- Fecha, quién corrió la verificación, contra qué base (`tourniquet_dev` + `rhpro_marcelino`).
- La tabla de arriba, completa.
- Las pruebas extra con su resultado.
- **Lo pendiente**, si hay algo, con la fase a la que vuelve.
- El veredicto: la Fase 01 de `specs/04` está **cerrada** o **no**.

Sin firma, el acta no vale. Con nombre, fecha y resultado, es el punto contra el que se puede
revisar el sistema en un año.

### 4. Actualizar los estados

- `specs/todo/begin/README.md`: la tabla de estado, con las fases cerradas y su commit.
- `specs/04-fases.md`: la fila de la Fase 01, con la fecha y la referencia al acta.

Si algo quedó a medias, la fila dice **parcial** y lista qué falta. No se marca cerrada una fase
con un criterio sin verificar.

---

## Criterios de aceptación

- [ ] Los 9 criterios de `specs/04` Fase 01 están marcados con resultado, fecha y responsable.
- [ ] Las 10 pruebas extra están corridas y anotadas.
- [ ] El acta existe en `specs/todo/begin/acta-cierre-fase-01.md` y tiene veredicto.
- [ ] `specs/04-fases.md` y el `README.md` de la carpeta reflejan el estado real.
- [ ] Si el veredicto es "no cerrada", la lista de pendientes es accionable: cada ítem con su fase.
- [ ] La base de control se puede **reconstruir** desde cero en otra base con sólo `deploy/sql/` y
      la prueba de humo pasa contra esa reconstrucción (no es lo mismo que borrarla y volver a
      crearla en el mismo lugar: es crear en otra base y verificar que el IdP funciona).

---

## Nota sobre el nombre de la fase

Es la única fase del plan que no produce código. Existe porque en un repo sin tests, la diferencia
entre "funciona" y "creo que funciona" es un documento. Sin él, la Fase 02 arranca sobre una base
de nadie.

## Trampas

1. **Marcar la fase cerrada con "casi todo anda".** El criterio 3 (refresh reusado ⇒ revocación de
   familia) es el que más fácil falla y el que más caro sale: es el que corta un robo de token. Si
   falla, es defecto, y vuelve a la 03.
2. **Probar con datos de un solo cliente.** Todas las pruebas de tenant necesitan dos clientes. Si
   la base tiene uno solo, no se puede verificar la travesía entre tenants, y esa es exactamente la
   invariante de D2.
3. **Correr las pruebas con el backend en modo desarrollo.** Sin `NODE_ENV=production`, rutas como
   `/dev/token` existen y los mensajes de error son verbosos. El acta tiene que decir en qué modo
   se corrió.
4. **El acta sin commit asociado.** Una lista de resultados sin el commit contra el que se
   corrieron no sirve para nada un año después. El `README.md` lleva la columna de commit.
