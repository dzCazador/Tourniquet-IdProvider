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

**Consecuencia práctica:** todo el material gráfico del tema es **SVG original o textura CSS**,
generado en `frontend/src/design/`, con licencia del repo. Nada se descarga de internet ni se
incluye con atribución a terceros.

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

| Token | Hex | Uso | Contraste sobre `tinta` |
|---|---|---|---|
| `tinta` | `#0a0a0c` | Fondo de página | — |
| `tinta-alta` | `#121216` | Fondo de panel / campo | 1.3:1 (decorativo) |
| `hierro` | `#1c1c22` | Bordes faibles, separadores | decorativo |
| `plata` | `#c8ccd4` | **Borde de control, texto secundario fuerte** | 10.8:1 ✔ |
| `hueso` | `#e8e2d6` | **Texto de cuerpo** | 14.6:1 ✔ |
| `pergamino` | `#f2ede3` | Texto sobre `oxblood` | 9.1:1 ✔ |
| `oxblood` | `#7a0f16` | Acento, encabezado de sección, sello | 2.1:1 (decorativo) |
| `sangre` | `#c2343c` | **Error**: texto de error, borde de campo inválido | 5.9:1 ✔ |
| `brasa` | `#c9a227` | Acento de estado, foco secundario, sello activo | 8.1:1 ✔ |
| `verdigris` | `#4a8072` | Éxito, sesión activa | 5.3:1 ✔ |

Reglas de aplicación:

- El rojo de error es `#c2343c` (5.9:1), **no** `#7a0f16` (2.1:1, no alcanza). `oxblood` es
  decorativo; `sangre` es funcional.
- Nunca texto sobre `oxblood` en `#a1121c` (2.8:1). Sobre oxblood va `pergamino` (9.1:1) o `hueso`.
- El foco de teclado es `brasa` con `outline: 2px solid` + `outline-offset: 2px`, y un segundo anillo
  `hueso` de 1 px por fuera: se ve sobre cualquier fondo, incluso sobre `pergamino`.
- Estados deshabilitados: `plata` al 40 % sobre `hierro` = 1.2:1, **sólo para texto decorativo**. Un
  control deshabilitado que trasmite información real (`opacity-50` sobre texto que hay que leer) es
  un defecto de accesibilidad, no una decisión estética.
- No se usa `mix-blend-mode` para ganar legibilidad: `backdrop-filter` y gradientes sí.

---

## 5. Texturas y ornamentos (todo SVG/CSS propio)

| Nombre | Qué es | Dónde | Peso |
|---|---|---|---|
| `anillo` | Anillo de hierro con muesca y remache (el tourniquet) | Detrás del logo, badge de sesión | 8 KB |
| `placa` | Placa de latón grabada con borde biselado | Tarjetas de app, panel del cliente | 6 KB |
| `costura` | Línea punteada tipo pespunte, nudo central | Separadores de sección (`—✦—`) | 1 KB |
| `malla` | Patrón de red de 24 px, opacidad 0.04 | Fondo del plano de login | 3 KB |
| `grano` | Grano fino de película (filtro SVG `feTurbulence`) | Sobre `tinta`, opacidad 0.03 | 2 KB |
| `sello` | Sello de lacre con `TQ` y el código del cliente | Estado "sesión sellada", apps habilitadas | 4 KB |
| `mancha` | Tinta que se seca (radial-gradient) | Transición de carga del botón | CSS |

Todos inline (sin request extra) o como `data:` URI en CSS. Presupuesto: **< 60 KB** de gráficos
totales, medidos con `ls -l frontend/src/design/ornaments`.

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
| `/login` | **Alto** | Plano de login como "placa en una pared": wordmark con anillo, campo de usuario, campo de clave, botón. Fondo `malla`+`grano`. Abajo, aviso sobrio de privacidad y ayuda. **Sin** eslogan, sin lirismo, sin tips de la canción |
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
   hover/focus/disabled de cada control).
4. Blackletter sólo en el wordmark: `grep -ri "unifraktur" frontend/src` devuelve sólo los 2
   archivos del logo y el favicon.
5. Con `prefers-reduced-motion: reduce`, no hay ninguna animación en las 6 vistas.
6. Zoom 200 % y ancho 360 px: sin scroll horizontal en `/login`, `/apps`, `/admin`, `/mi-cuenta`.
7. Navegación por teclado completa: login, consent, apps, cierre de sesión y 6 dígitos de MFA,
   con foco siempre visible.
8. El gestor de contraseñas ofrece guardar la clave en `/login` (probado en Chrome y Firefox).
9. Imágenes: 0 requests a terceros; 0 PNG/JPG del tema; sólo SVG inline y CSS.
10. Presupuesto de tema: < 60 KB de ornamentos, < 40 KB de fuentes auto-alojadas por peso usado
    (subconjunto latino).

---

## 10. Archivos de esta fase

```
frontend/src/design/
├── tokens.ts             // colores, spacings, radios, sombras, duraciones (fuente única)
├── fonts.ts              // next/font: UnifrakturMaguntia, Cinzel, EB Garamond, Inter, JetBrains Mono
├── ornaments/
│   ├── Anillo.tsx        // anillo de hierro (logo, badge)
│   ├── Placa.tsx         // marco de placa grabada
│   ├── Costura.tsx       // separador —✦—
│   ├── Malla.tsx         // textura de red
│   ├── Grano.tsx         // grano de película
│   └── Sello.tsx         // sello de lacre
├── components/
│   ├── Boton.tsx         // primary/secondary/danger, tamaños, aria-busy
│   ├── Campo.tsx         // input con label visible, error, hint, foco brasa
│   ├── PlacaApp.tsx      // tarjeta de app en el lanzador
│   └── Lamina.tsx        // lámina de 404/500
└── motion.ts             // duraciones y curvas; respeta prefers-reduced-motion
```

`tokens.ts` es la **única** fuente de valores: ningún componente escribe hex sueltos
(`grep -rn "#[0-9a-f]\{6\}" frontend/src/app` no debe matchear; los hex sólo en `tokens.ts` y en los
ornamentos).

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
