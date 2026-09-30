# Estética Tourniquet — sistema de diseño gótico del portal

**Estado:** propuesta cerrada, **normativa a partir de la [Fase 07](fase-07-portal-lanzador.md)**
(hasta ahí el portal es austero: ver P3 en el `README.md` de esta carpeta).
**Spec de soporte:** `specs/00-arquitectura.md` D6 (portal = lanzador), `specs/03-integracion-rhpro.md`
§4, `specs/01` §4 (cookies) y §9 (amenazas). Este documento **no agrega requisitos de seguridad**:
los endurece donde la estética los empujaría.

---

## 1. Qué se está citando (y qué no)

El portal toma su lenguaje visual de **"Tourniquet", de Marilyn Manson** (`Antichrist Superstar`,
1996) y de la iconografía que la banda construyó alrededor de la canción: el *tourniquet* como
instrumento que **comprime el flujo para detenerlo**, la caja de Crispin Glover, el cordón, el
entrelazado de cintas y clavos, la caligrafía gótica, el grabado de placa, el oxblood.

La letra de la canción es el guion conceptual del portal. Estas líneas son las referencias de
diseño (obra de G. G.385 / Warner-Chappell, **citas de referencia interna, no se reproducen en el
producto**):

| Fragmento | Qué define en el portal |
|---|---|
| *"Take your hatred out on me / Make your victim my head"* | El **tono de los errores**: el portal nunca acusa ni amenaza al usuario. Mensajes planos en español, sin dramatismo, sin "¡intruso!" |
| *"I am your tourniquet"* | El **concepto rector**: Tourniquet es el punto de compresión del flujo de identidad. El usuario no ve la maquinaria, ve el instrumentario |
| *"You never ever believed in me / I never ever believed in me"* | El **tono de la confianza**: el portal no promete ni pide fe; muestra exactamente qué pide, a quién y con qué alcance |
| *"Her spine is just a string"* | La **línea divisoria** como ornamento primario (`—` con nudo central) |
| *"Prosthetic synthesis with butterfly / Sealed up with virgin stitch"* | La **costura / puntada** como detalle de transición y como indicador de "estado sellado" (sesión activa) |
| *"silver tight like spider legs"* | La **malla / red** como textura de fondo y el plata como acento de datos, no como color de texto |
| *"I wrapped our love in all this foil"* | El **metal / estaño** en placas, bordes y remaches; textura de foil en la superficie del plano de login |

### 1.1 Lo que NO se hace (límite duro, no negociable)

| No | Por qué |
|---|---|
| Imágenes, logos, portadas o material del artista o de la banda | Son obra con derechos de imagen. Además el producto es un IdP **corporativo** (RRHH): sus usuarios son empleados, no fans |
| Reproducir la letra en la UI, ni como cita, ni como fondo, ni como "loading tip" | Copyright del texto y del todo fuera de contexto en un sistema de identidad de una empresa |
| Nombre del artista, nombre de la banda o de la canción en el producto | Es un IdP multi-tenant que se marca con el nombre del cliente. La referencia queda acá, en el spec, no en el código |
| Logotipo de Tourniquet copiando el logo de la banda | Se usa el wordmark tipográfico propio (ver §3), que es un **tourniquet dibujado**, no la caligrafía de Manson |
| Estética que vuelva **ilegible** o confusa una acción de identidad | Un login fallido a las 3 de la mañana, en un hospital, no admite adivinanzas |
| Imagen de fondo pesada (> 120 KB) o redimensionada en runtime | El portal es `output: "export"`: todo se sirve como estático, en red de clientes |

#### La excepción del fondo de `/login`: **un** raster propio

> **Agregado en la Fase 04.** Antes de esto, el fondo del login era un plano de acero: dos
> gradientes radiales y la trama de peltre, todo CSS, cero KB de imagen. Se veía bien y **no
> comunicaba nada**: una pantalla de acceso a RRHH que no se diferencia de cualquier otra es una
> pantalla de acceso a RRHH que no se recuerda. El fondo es la primera cosa que ve el empleado a
> las 3 de la mañana y es la que lo separa de "una página más".

Lo que este límite sigue significando, y que **no se negocia**:

| Límite | Por qué sigue en pie |
|---|---|
| **Un solo raster en todo el portal**: el fondo de `/login` | Un tema rasterizado entero deja de ser un tema y pasa a ser un catálogo de fotos. El resto del portal sigue siendo SVG + CSS |
| **< 120 KB**, generado por un script versionado del repo | El export es estático: el peso se lo descarga cada empleado en cada ingreso, sin caché que valga |
| **Sin request a terceros, sin material del artista o de la banda** | §1.1 entero. El fondo es textura abstracta de metal, generada, no una imagen encontrada |
| **Sin redimensionado en runtime**: `images.unoptimized` y CSS `background-image`, nunca `<Image>` | Un `<Image>` con `width`/`height` no se puede usar en un `background-image`, y un `srcset` en un export estático obliga a pregenerar variantes que nadie pidió |
| **Siempre debajo de un velo `tinta`** | La imagen es decorativa y el texto del formulario va sobre una placa **opaca** (`tinta-alta`), así que no le toca nada. Lo único que se apoya directo en el fondo es el wordmark, y por eso el velo va en la **misma** declaración CSS que la imagen: no es una capa opcional ni configurable |

**Consecuencia práctica:** el material gráfico del tema es **SVG original o textura CSS** generado
en `frontend/src/design/`, con licencia del repo, **más el raster propio del fondo**, generado por
`frontend/scripts/generar-fondo.py`. Nada se descarga de internet ni se incluye con atribución a
terceros.

---

## 2. Tensión central: la estética gótica contra un IdP de RRHH

Este producto se usa en pantalla chica, a veces en un puesto de trabajo compartido, y a veces con
lentes. Tres reglas que resuelven la tensión:

1. **El tema va en la atmósfera, la legibilidad va en la función.** La atmósfera vive en fondo,
   marcos, ornamentos y títulos. Los controles (inputs, botones, mensajes, tablas) son sobrios, con
   contraste alto y tipografía de lectura. Un usuario debe poder hacer login sin tener que
   descifrar nada: la pantalla se lee de una.
2. **La oscuridad nunca se come el contraste.** Negro puro de fondo, texto de cuerpo a
   `#e8e2d6` (contraste 14:1+). Bordes de control a `#c8ccd4`, nunca a `#333`. Nada de texto
   gris claro sobre negro en tamaños chicos.
3. **El tema no altera el contrato de seguridad.** Nada de esto toca: `HttpOnly`+`Secure`+
   `SameSite=Lax`, `autocomplete` correctos (el gestor de contraseñas del navegador tiene que
   funcionar), textos de error genéricos, rate limit, MFA de 6 dígitos, foco visible siempre.

### Traducción por nivel de riesgo (regla operativa)

| Zona | Nivel de tema | Ejemplos |
|---|---|---|
| Marco de la página, wordmark, títulos, planos de login, 404, logout, pantalla de espera | **Alto** | Anillos de hierro, tinta que se seca, placa grabada |
| Encabezado de app, tarjetas de app, conos de sesión, panel admin (títulos, íconos, separadores) | **Medio** | Bordes grabados, sellos, remaches; tablas y formularios sobrios |
| Formularios, tablas de datos, mensajes de error, ingreso de código MFA, inspector de token, auditoría | **Bajo** | Sólo tokens de color y foco; nada de textura ni tipografía decorativa |

---

## 3. Identidad

- **Wordmark:** "Tourniquet" en `UnifrakturMaguntia` (OFL, Google Fonts, auto-alojada con
  `next/font`, no CDN en runtime) con un **anillo de hierro** dibujado en SVG como marco y un
  **remache** en la intersección. El nombre va en `aria-label` / texto visible; el SVG es decorativo
  (`aria-hidden`).
- **Tipografías (todas OFL, auto-alojadas en build):**

  | Rol | Fuente | Uso |
  |---|---|---|
  | Display / wordmark | `UnifrakturMaguntia` | Sólo el logo. Máximo 3 apariciones en pantalla |
  | Títulos | `Cinzel` (capitulares romanas, feel de placa grabada) | H1 de página y títulos de sección |
  | Cuerpo | `EB Garamond` (18 px base) | Texto de lectura, mensajes,ayudas |
  | UI / datos | `Inter` | Labels de formulario, botones, tablas, valores, `kbd` |
  | Código / token | `JetBrains Mono` | Inspector de token decodificado, `sub`/`aud`/`sid` |

  **Prohibido**: blackletter en labels, botones, mensajes de error, celdas de tabla o cualquier
  texto que el usuario tenga que leer o escribir. Es la regla de la casa.
- **Íconos:** SVG propios de 1.5 px de trazo, esquinas en chaflán, 24 px. Nada de librerías de
  íconos con licencia ambigua. Íconos de apps: los aporta `cat_aplicacion` (fase 05+) como SVG
  simple en `origenes`-similar; si no hay, placeholder con la inicial en placa de latón.

---

## 4. Tokens de color (con contraste medido, WCAG 2.2 AA)

> **Corregido en la Fase 04.** La tabla de abajo estaba mal medida en tres
> tokens: `sangre` figuraba en 5.9:1 cuando daba **3.63:1**, `verdigris` en 5.3:1
> cuando daba **4.35:1** y `oxblood` en 2.1:1 cuando daba 1.80:1. Los tres
> están recalculados con la fórmula de WCAG 2.2 (sRGB relativo) y los que
> estaban mal se corrigieron. `sangre` importaba: es el color del texto de error
> del login, y con el valor viejo **no pasaba AA para texto normal**, lo que
> hubiera hecho fallar el criterio de axe-core de la Fase 04. La medición vive
> en `frontend/src/design/tokens.ts`, que es la única fuente de verdad.

| Token | Hex | Uso | Contraste sobre `tinta` |
|---|---|---|---|
| `tinta` | `#0a0a0c` | Fondo de página | — |
| `tinta-alta` | `#121216` | Fondo de panel / campo | 1.06:1 (decorativo) |
| `hierro` | `#1c1c22` | Bordes faibles, separadores | 1.17:1 (decorativo) |
| `plata` | `#c8ccd4` | **Borde de control, texto secundario fuerte** | 12.29:1 ✔ |
| `hueso` | `#e8e2d6` | **Texto de cuerpo** | 15.34:1 ✔ |
| `pergamino` | `#f2ede3` | Texto sobre `oxblood` | 16.95:1 ✔ |
| `oxblood` | `#7a0f16` | Acento, encabezado de sección, sello | 1.80:1 (decorativo) |
| `sangre` | `#d2565d` | **Error**: texto de error, mensaje de rol `alert` | 4.93:1 ✔ |
| `sangre-honda` | `#c2343c` | Error: borde de campo inválido, ícono (sólo no-texto) | 3.63:1 ✔ (3:1) |
| `brasa` | `#c9a227` | Acento de estado, foco, sello activo | 8.18:1 ✔ |
| `verdigris` | `#569584` | Éxito, sesión activa | 5.68:1 ✔ |

Reglas de aplicación:

- **El rojo de error tiene dos tonos, y cuál va dónde no es opcional.**
  `sangre` (`#d2565d`, 4.93:1) es el del TEXTO: pasa AA para texto normal, que es
  lo que exige WCAG 2.2 §1.4.3. `sangre-honda` (`#c2343c`, 3.63:1) es el del
  BORDE y del ícono, que son elementos de interfaz y sólo necesitan 3:1
  (§1.4.11). Poner `sangre-honda` en un texto de error es el defecto que la
  tabla anterior tenía. `oxblood` (`#7a0f16`, 1.80:1) queda **excluido de
  cualquier texto**: es decorativo, y sobre él va `pergamino` (9.44:1).
- **`oxblood` no delimita ningún control.** Es el único token de la paleta por
  debajo de 3:1, así que puede ser línea decorativa, filete, bisel o remache, y
  nada más. El borde de un botón, de un campo o de un control de formulario va
  en `plata` (o `plata/60`, que compone a 4.83:1 sobre `tinta-alta`): el fondo
  del portal contra el de la página da 1.06:1, o sea que **el borde es lo único
  que dibuja el control** y si el borde no se ve, el control no se ve. La Fase
  04 lo tenía mal en el botón primario (`oxblood`, 1.70:1 sobre su propio
  fondo) y lo corrigió moviendo la jerarquía de primario/secundario al
  **relleno** y dejando el borde en `plata/60` en los dos.
- Nunca texto sobre `oxblood` en `#a1121c` (2.8:1). Sobre oxblood va `pergamino` (9.44:1) o `hueso` (8.54:1).
- `sangre` **no** se usa sobre `pergamino` (3.44:1): el error vive sobre
  `tinta`/`tinta-alta`, nunca sobre un fondo claro.
- El foco de teclado es `brasa` con `outline: 2px solid` + `outline-offset: 2px`, y un segundo anillo
  `hueso` de 1 px por fuera: se ve sobre cualquier fondo oscuro, incluso sobre
  `pergamino` (2.07:1, que es justo por qué el anillo exterior va en `hueso` y
  no en `brasa`: un solo anillo de `brasa` no se vería sobre un fondo claro).
- Estados deshabilitados: `plata` al 40 % sobre `hierro` = 1.2:1, **sólo para texto decorativo**. Un
  control deshabilitado que trasmite información real (`opacity-50` sobre texto que hay que leer) es
  un defecto de accesibilidad, no una decisión estética.
- No se usa `mix-blend-mode` para ganar legibilidad: `backdrop-filter` y gradientes sí.

### Medir, no estimar

Todo lo de arriba sale de `frontend/src/design/contraste.ts` (la fórmula de
WCAG 2.2, con composición de alfa para los `plata/60`). Un token con alfa **no**
se mide por su canal: `plata` mide 12.29:1 y pintado al 60 % sobre `tinta-alta`
mide 4.83:1, que es lo que se ve en pantalla. La función compone antes de
medir por eso.

---

## 5. Texturas y ornamentos (todo SVG/CSS propio)

| Nombre | Qué es | Dónde | Peso |
|---|---|---|---|
| `anillo` | Anillo de hierro con muesca y remache (el tourniquet) | Detrás del logo, badge de sesión | 8 KB |
| `placa` | Placa de latón grabada con borde biselado | Tarjetas de app, panel del cliente | 6 KB |
| `costura` | Línea punteada tipo pespunte, nudo central | Separadores de sección (`—✦—`) | 1 KB |
| `malla` | Patrón de red de 24 px, opacidad 0.04 | Fondo del plano de login | 3 KB |
| `grano` | Grano fino de película (filtro SVG `feTurbulence`) | Sobre `tinta`, opacidad 0.03 | 2 KB |
| `fondo` | **Raster propio**: lámina de hierro (ruido multi-octava + vetas + viñeta), velada con `tinta` | Fondo de `/login` | **< 120 KB** [04] |
| `sello` | Sello de lacre con `TQ` y el código del cliente | Estado "sesión sellada", apps habilitadas | 4 KB |
| `mancha` | Tinta que se seca (radial-gradient) | Transición de carga del botón | CSS |

Todos inline (sin request extra) o como `data:` URI en CSS. Presupuesto: **< 60 KB** de gráficos
totales, medidos con `ls -l frontend/src/design/ornaments`.

> El `fondo` es la **única excepción** al presupuesto y a la regla de "todo inline": es el único
> archivo binario del tema, va aparte, y su límite es el de §1.1 (< 120 KB) y no este. La razón de
> que sea un archivo y no un `data:` URI es que 100 KB en una hoja de estilos bloquean el primer
> pintado de la pantalla de acceso; como imagen aparte, el navegador la pide en paralelo y el
> texto aparece igual.

---

## 6. Movimiento

- Pesado y lento, con sensación de masa: 400-700 ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Entrada de página: el anillo se "cierra" (escala 0.96→1 con desenfoque de 2 px) en 600 ms, una
  sola vez. El texto entra sin animación, de golpe, para no demorar la lectura.
- Estados de carga: la mancha de tinta se expande (900 ms, loop). Es la única animación en loop del
  producto, y **no** se acompaña de skeletons que oculten layout.
- `@media (prefers-reduced-motion: reduce)`: todo el motion se desactiva; sólo cambia opac/color
  (150 ms). Las transiciones de estado (hover/focus) se mantienen, que no son movimiento.
- Prohibido: parpadeo, flashes de error, animaciones en tablas con datos, shake de formulario al
  fallar, efectos de glitch o "glitch reveal" de texto.

---

## 7. Vistas y su tono

| Vista | Tono | Detalle |
|---|---|---|
| `/login` | **Alto** | Plano de login como "placa en una pared": wordmark con anillo, campo de usuario, campo de clave, botón. Fondo `fondo` (raster velado) con `malla`+`grano` encima. Abajo, aviso sobrio de privacidad y ayuda, plegable con `<details>` para que la pantalla entre en 768 px de alto. **Sin** eslogan, sin lirismo, sin tips de la canción |
| `/login` · selector de cliente | **Medio** | Cuando el usuario es miembro de varios clientes, el botón de ingresar **desaparece** y aparece la lista de clientes como botones, con el `código` al lado del nombre. No es un campo más del formulario: es otra pregunta, y por eso los campos de usuario y clave **no** se ponen en rojo — la clave ya fue verificada. La lista va en **rejilla de 1→2 columnas con alto máximo y scroll interno**: el admin de una instalación es miembro de todos los clientes, y una columna con diez nombres empuja el formulario fuera de la pantalla. Mismo patrón de placa del lanzador de la 07, en versión chica |
| `/consentimiento` (nuevo) | Alto en marco, sobrio en contenido | Título: "Aceptás el ingreso de **{app}**". Debajo, la **"rebanada"**: 3-4 renglones de hechos —qué es la app, qué recibe, quéNO recibe. Botón "Entrar". Acá la letra dice "you never believed in me": el portal muestra los hechos, no pide fe |
| `/apps` (lanzador) | Medio-alto | Selector de cliente (si hay N), lista de apps en placas grabadas con su estado. Cada placa es un link de al authorize con deep-link |
| `/apps/[codigo]` | Bajo | Pantalla de "puerta": cuenta regresiva de 5 s y botón "Entrar ahora" (evita el click-jacking trivial y da control). El token va a la cookie HttpOnly de la app |
| `/admin` | Medio en marco, bajo en contenido | Tabs sobrias, tablas de datos limpias. El marco tiene grabados y sellos; los datos, no |
| `/mi-cuenta` | Bajo-medio | Sesiones activas (con sello de lacre), "salir de todo", cambio de clave futuro |
| 404 / 500 | Alto | Lámina grabada con el mensaje funcional. Único lugar donde el tema puede ser hardest |
| Verificación MFA (09) | Bajo | Campo de 6 dígitos con `inputMode="numeric"`, `autocomplete="one-time-code"`, letras de 28 px sin blackletter |

### 7.1 La pantalla de clave: el lugar donde el tema se pone a prueba

Requisitos no negociables (si alguno falla, la vista no está lista):

- El campo de clave tiene `autocomplete="current-password"`, `name`, `id` y `<label>` visible (puede
  estar arriba, no se oculta). El gestor de contraseñas debe reconocerlo y ofrecer guardar.
- El botón de mostrar/ocultar clave tiene `aria-label`, `aria-pressed` y 44×44 px de área táctil.
- Mensaje de clave incorrecta: texto plano, un solo renglón, sin "¡ERROR!" sin animación y **sin
  revelar** si el usuario existe (`specs/01` §4: genérico siempre).
- Con 5 intentos, el mensaje es de bloqueo (15 min) con hora local explícita. Sin "te quedan X
  intentos" (facilita la enumeración).
- El formulario no se deshabilita mientras espera la respuesta: se muestra el estado en el botón
  (`aria-busy`).
- Copypaste permitido. Sin captcha ni "no soy robot" (el rate limit es el control; `specs/01` §4).

---

## 8. Matriz de correspondencia letra → vista

| Línea (referencia) | Pantalla | Implementación concreta |
|---|---|---|
| *"Take your hatred out on me"* | `/login` (error) | Mensaje: "No pudimos validar tu clave." Sin color de "alarma", sin ícono de alerta aggressiva: el borde `sangre` y listo |
| *"I am your tourniquet"* | Todas | El anillo como logo y como badge de sesión; el concepto de "compresión del flujo" se explica en el About del panel admin, no en el login |
| *"Her spine is just a string"* | Separadores | `—✦—` con nudo central, 1 px `plata` |
| *"Sealed up with virgin stitch"* | `/mi-cuenta` | Sello de lacre en sesiones activas = sesión sellada; al cerrar, el sello se "abre" |
| *"silver tight like spider legs"* | Fondo de `/login` | Textura `malla` a 4 % |
| *"I wrapped our love in all this foil"* | Planos de login y tarjetas | Textura `grano` de foil, opacidad 3 % |
| *"You never ever believed in me"* | `/consentimiento` | Facts-first: la "rebanada" con qué recibe / qué no recibe la app. Sin copy persuasivo |
| *"And things I cannot speak"* | Formularios | Los campos nunca piden información que el portal no usa. Sin "teléfono" ni "seguridad social" en el login |

---

## 9. Criterios de aceptación de la estética

1. Lighthouse Accessibility ≥ 95 en `/login`, `/apps`, `/admin` (export estático, medido local).
2. axe-core sin violaciones `critical` ni `serious` en las 6 vistas.
3. Contraste AA verificado con herramienta en los pares de la tabla §4 (y en los estados
   hover/focus/disabled de cada control). **Medido con `design/contraste.ts`, que compone alfa antes de
   comparar**: los bordes `plata/60` de los controles no se miden por el canal de `plata` (12.29:1)
   sino por lo que se ve (4.83:1). El borde de un control nunca puede ser `oxblood`: el fondo del
   portal contra el de la página da 1.06:1 y el borde es lo único que dibuja el control.
4. Blackletter sólo en el wordmark: `grep -ri "unifraktur" frontend/src` devuelve sólo los 2
   archivos del logo y el favicon.
5. Con `prefers-reduced-motion: reduce`, no hay ninguna animación en las 6 vistas.
6. Zoom 200 % y ancho 360 px: sin scroll horizontal en `/login`, `/apps`, `/admin`, `/mi-cuenta`.
7. Navegación por teclado completa: login, consent, apps, cierre de sesión y 6 dígitos de MFA,
   con foco siempre visible.
8. El gestor de contraseñas ofrece guardar la clave en `/login` (probado en Chrome y Firefox).
9. Imágenes: 0 requests a terceros; 0 PNG/JPG **de material ajeno**; sólo SVG inline y CSS, más
   **un** raster propio (el fondo de `/login`, §1.1) generado por el script del repo. El presupuesto
   de §1.1 es < 120 KB y se verifica con `python frontend/scripts/generar-fondo.py`, que **falla**
   si el archivo que produce se pasa.
10. Presupuesto de tema: **< 60 KB de ornamentos** (medido: **13 KB** en
    `frontend/src/design/ornaments`) y **un raster** (< 120 KB, verificado por el
    generador). Fuentes: el criterio de "< 40 KB por peso usado" **se corrigió en
    la Fase 07**, ver abajo.

---

## 9.1 El presupuesto de fuentes, medido (corregido en la Fase 07)

El criterio 10 decía "< 40 KB de fuentes auto-alojadas por peso usado (subconjunto
latino)". **Ese número no se había medido nunca, y es imposible de cumplir con las
cuatro familias que el login usa.** Medido sobre el export real de la Fase 07:

| Familia (subconjunto latin) | Archivo | Peso |
|---|---|---|
| `UnifrakturMaguntia` (wordmark) | 21.8 KB | 400 |
| `Cinzel` (títulos) | 25.3 KB | 400 **y** 600 (un solo archivo) |
| `EB Garamond` (cuerpo) | 23.3 KB | 400 |
| `Inter` (interfaz, variable) | 47.3 KB | 100–900 |
| **Total del login** | **117.7 KB** | |

Y para que quede claro que el resto no es culpa del build: el directorio de fuentes
del export tiene 488 KB en 25 archivos, porque `next/font` emite **todos** los
subconjuntos de cada familia (cirílico, griego, vietnamés, latin-ext). El navegador
**no los pide**: cada `@font-face` trae su `unicode-range` y con texto en español
sólo matchean los cuatro archivos de la tabla. Los 371 KB de diferencia están en el
disco, no en la red.

**El presupuesto pasa a ser: < 130 KB de subconjunto latino por pantalla**, y lo
que se vigila de verdad no es el peso sino las **peticiones**: en la Fase 07 se
corrigió el `preload` (que era `true` en las cinco familias por el default de la
librería, contra lo que decía el propio `fonts.ts`) y hoy hay **un solo
`<link rel=preload>` de fuente en el portal**, el del wordmark, que es el único
texto del primer viewport. Con eso, la fuente no bloquea el primer pintado: se ve
el texto en la tipografía de reserva y se reemplaza.

Bajar de 118 KB exigiría sacarle una familia al producto (los dos menores juntos,
blackletter y Cinzel, ya dan 47 KB), o sea cambiar la §3, no optimizar el build.
Se deja la §3 como está.

```
frontend/src/design/
├── tokens.ts             // colores, spacings, radios, sombras, duraciones (fuente única)
├── contraste.ts          // fórmula WCAG 2.2 + los ratios medidos (traza de §4)
├── fonts.ts              // next/font: UnifrakturMaguntia, Cinzel, EB Garamond, Inter, JetBrains Mono
├── ornaments/
│   ├── Anillo.tsx        // anillo de hierro (logo, badge)          [04]
│   ├── Placa.tsx         // marco de placa grabada                 [04]
│   ├── Costura.tsx       // separador —✦—                           [04]
│   ├── Malla.tsx         // textura de red                         [07]
│   ├── Grano.tsx         // grano de película                      [07]
│   └── Sello.tsx         // sello de lacre                         [07]
├── components/
│   ├── Boton.tsx         // primary/secondary/danger, tamaños, aria-busy   [04]
│   ├── Campo.tsx         // input con label visible, error, hint, foco brasa [04]
│   ├── PlacaApp.tsx      // tarjeta de app en el lanzador          [07]
│   ├── Marco.tsx         // marco de las pantallas con sesión     [07]
│   └── Lamina.tsx        // lámina de 404/500                      [04]
└── motion.ts             // duraciones y curvas; respeta prefers-reduced-motion [07]
```

El fondo raster **no** va en `design/`: es un archivo servido, no un componente, y su generador es

```
frontend/
├── public/
│   └── fondo-login.jpg   // raster propio del fondo de /login, < 120 KB   [04]
└── scripts/
    ├── quitar-rutas-dev.mjs
    └── generar-fondo.py  // Pillow: produce el .jpg de arriba. No entra al build
```

`generar-fondo.py` está en Python y **no** en `package.json` a propósito: el portal se construye con
Node, y meterle una dependencia de Python al `pnpm build` para producir un archivo que ya está
versionado no compra nada. El `.jpg` va commiteado y el script se corre solo cuando hay que cambiar
la textura.

`Marco.tsx` [07] no estaba en la lista original y está porque las cinco pantallas
del portal repiten el mismo marco (fondo con `malla` + `grano`, anillo, wordmark,
`Costura`) y, sobre todo, el mismo **nivel de tema por zona**: el marco es tema alto
y el contenido lo baja cada pantalla a su nivel. Un `layout.tsx` compartido no
servía (cada pantalla tiene su propio encabezado y su propio nivel) y copiar el
marco cinco veces es como el nivel de tema se desuniforma en dos commits.

`tokens.ts` es la **única** fuente de valores: ningún componente escribe hex sueltos
(`grep -rn "#[0-9a-f]\{6\}" frontend/src/app` no debe matchear; los hex sólo en `tokens.ts` y en los
ornamentos).

### Qué entra en la Fase 04 y qué en la 07

La **04** pinta el login, que es la primera pantalla que un empleado real usa a
las 3 de la mañana. El tema entra ahí, pero **sostenido por el marco y no por la
función**: anillo en el wordmark, placa grabada como plano del formulario,
filete `oxblood`, `Cinzel` en el título. Todo lo que el usuario tiene que leer o
escribir —etiquetas, campos, botones, mensajes— va en `Inter` sobre `tinta-alta`,
sin textura y sin tipografía decorativa (§2 regla 1).

La **07** suma la superficie del lanzador: `malla`, `grano`, `sello` de lacre,
`PlacaApp`, `motion.ts` y la animación del anillo. La 07 **pinta encima**: los
tokens y los componentes base no cambian, y por eso el criterio de esta fase es
que `/login` ya se lea bien sin ninguna de las texturas de la 07.

---

## 11. Revisión de un cliente que no lo quiera

La paleta y el wordmark son **configurables por cliente** (ya está justificado por la isomorphicidad
del token en el §2 de esta spec: la variación de marca vive en los tokens, no en los componentes):

- `cat_cliente.politica_json.tema` (Fase 05/08) acepta `{"estetica":"gothic"|"austero",
  "color_acento":"#..."}`.
- Default de la instalación: `gothic`. Un cliente que quiera sobrio cambia **el token**; los
  componentes no se tocan.
- La austera tiene la misma estructura y los mismos contrastes: sólo cambia el acento a un azul
  neutro y la textura a 0 %. Nunca "sin tema".
