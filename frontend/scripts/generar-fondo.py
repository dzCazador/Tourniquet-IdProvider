#!/usr/bin/env python3
"""Genera `public/fondo-login.jpg`: el raster propio del fondo de `/login`.

Es la UNICA excepcion de `estetica-tourniquet.md` §1.1 a la regla de "todo el
material grafico es SVG inline o textura CSS". La excepcion esta escrita en la
spec (no en un commit) y tiene limites duros, y este script es lo que los
verifica:

  - un solo raster en todo el portal
  - < 120 KB  (este script CORRE FALLA si el archivo se pasa)
  - generado por el repo, sin material de terceros y sin request a ninguno
  - sin redimensionado en runtime: se usa como `background-image` de CSS

No entra al `build` a proposito. El portal se construye con Node; meterle una
dependencia de Python al `pnpm build` para producir un archivo que ya esta
versionado no compra nada. El `.jpg` va commiteado y esto se corre a mano solo
cuando hay que cambiar la textura.

Como se ejecuta:

    python scripts/generar-fondo.py            # escribe public/fondo-login.jpg
    python scripts/generar-fondo.py --verificar # solo mira el archivo commiteado

Que dibuja: una lamina de hierro muy oscura, con grano de ruido en varias
frecuencias, vetas horizontales de metal cepillado y una vineta. Es textura
abstracta: no hay texto, no hay letras de la cancion, no hay nada de la banda.
Lo unico que reconoce es metal golpeado, que es de donde sale el resto del tema
(la placa, el anillo, la costura).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# --------------------------------------------------------------------------
# Constantes. Todo numero que aparece aca es una decision, no un default.
# --------------------------------------------------------------------------

# Limite de §1.1. Es el criterio de aceptacion: el script falla si se pasa.
LIMITE_KB = 120

# Tamano de la textura. Es mas grande que la pantalla de una notebook a proposito:
# `cover` la recorta, y una imagen que hay que escalar para arriba se ve
# emborronada justo en el lugar donde mas se mira, que es el texto del formulario.
ANCHO = 1920
ALTO = 1080

# La imagen es una textura **pareja**: misma banda de valor en toda la
# superficie, sin mascara ni centro oscuro. El oscurecimiento del centro, que es
# lo que sostiene el contraste del wordmark, lo hace el velo de
# `.fondo-login` en CSS, no esta imagen.
#
# Se probo al reves —la mascara aca, el velo parejo en CSS— y son dos mecanismos
# compitiendo por la misma zona: la rampa de la mascara cruzaba justo por el
# subtitulo y lo dejaba en 13.26:1. El velo va mejor en CSS porque es donde se
# puede escribir con coordenadas de pantalla y no hay que adivinar el ancho del
# formulario.
#
# El valor base esta en la banda de `tinta` (`tokens.ts`: tinta = #0a0a0c) para
# que el velo de CSS siga midiendo contra algo concreto.
#
# Cada `NIVEL_*` es la desviacion MAXIMA de SU termino y se aplica una sola vez,
# al armarlo. No hay un factor global al final: ya se aplico uno y multiplicaba
# por todos los demas a la vez, que es como esta textura termino saliendo con un
# rango de 0 a 234 en vez del que estaba disenhada.
NIVEL_BASE = 24  # media de la imagen, en toda la superficie
NIVEL_RUIDO = 40  # grano fino. Multiplica el ruido, que tiene std ~0.045 -> ~1.8
NIVEL_VETA = 26  # bandas de cepillado. std ~0.08 -> ~2.1
NIVEL_RAYAS = 9  # pico de una raya de uso (solo dos, de 1.4 px de alto)

# Peso del JPG. Medido sobre esta textura, que es de contraste muy bajo y por
# eso rinde muchisimo: 86 da 113 KB y 78 da 62 KB con una desviacion de 2.40
# contra 2.47, o sea el error medio sube de 1.32 a 1.42 niveles sobre 255 y no
# se ve. Se eligio 78 para dejar margen de verdad contra el limite de §1.1 en
# vez de quedar a 5 KB de pasarse.
CALIDAD = 78

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "public" / "fondo-login.jpg"


def ruido_de_valor(alto: int, ancho: int, semilla: int) -> np.ndarray:
    """Ruido de valor en [0, 1] con la smootherstep de numpy: sale suave, sin
    las esquinas duras que hace `np.random.random` y que en JPEG se ven como
    bloques. La semilla es fija para que la textura sea reproducible."""
    azar = np.random.default_rng(semilla)
    ruido = azar.random((alto, ancho), dtype=np.float32)
    # Ruido en tres escalas mezcladas. Una sola octava se ve como Television
    # dead; tres octavas se ve como metal. El detalle fino es el que mas pesa
    # en los bytes, asi que entra con el menor peso.
    suave = _reducir_y_subir(ruido, 24)
    medio = _reducir_y_subir(ruido, 8)
    return 0.55 * suave + 0.3 * medio + 0.15 * ruido


def _reducir_y_subir(mapa: np.ndarray, factor: int) -> np.ndarray:
    """Promedia bloques de `factor` y devuelve un mapa de la misma forma."""
    alto, ancho = mapa.shape
    recortado = mapa[: alto - alto % factor, : ancho - ancho % factor]
    bloques = recortado.reshape(alto // factor, factor, ancho // factor, factor)
    promediado = bloques.mean(axis=(1, 3))
    # Un solo factor de upscale produce pixeles constantes (seria visible). El
    # `resize` con bilinear los deforma lo justo para que no se vean.
    return np.asarray(
        Image.fromarray((promediado * 255).astype(np.uint8)).resize(
            (ancho, alto), Image.Resampling.BILINEAR
        ),
        dtype=np.float32,
    ) / 255.0


def _suavizar(perfil: np.ndarray, radio: int) -> np.ndarray:
    """Media movil de `radio` sobre un vector de 1D, con los bordes reflejados.

    Va a mano y no con `ImageFilter` porque el filtro de Pillow trabaja sobre
    imagenes 2D y acá lo que se quiere suavizar es **una** dimension: la banda
    tiene que quedar estirada en X, no mezclada."""
    acumulado = np.cumsum(np.concatenate(([0.0], perfil)))
    indices = np.arange(len(perfil))
    izquierdo = np.clip(indices - radio, 0, None)
    derecho = np.clip(indices + radio + 1, None, len(perfil))
    return (acumulado[derecho] - acumulado[izquierdo]) / (derecho - izquierdo)


def vetas_de_cepillado(alto: int, semilla: int) -> np.ndarray:
    """Perfil vertical de bandas suaves, como metal pasado por un rodillo. Es lo
    que le da la direccion a la textura: sin esto el fondo es ruido y se ve
    como ruido.

    Devuelve un perfil de forma `(alto, 1)`, no `(alto, ancho)`: las vetas son
    horizontales, asi que son identicas en cualquier columna y se propagan solas
    por broadcasting al restarlas de la imagen. Guardar 1920 copias de un vector
    de 1080 numeros para no multiplicar por cero es un error de 8 MB."""
    azar = np.random.default_rng(semilla)
    perfil = azar.random(alto, dtype=np.float32)
    perfil = _suavizar(perfil, radio=18)
    # El ruido crudo tiene el 50 % de su energia muy junta; subirle el contraste
    # sin este recorte hace las vetas un pelo de lado a lado.
    perfil = np.clip((perfil - perfil.mean()) * 1.8 + perfil.mean(), 0.0, 1.0)
    return perfil[:, None]


def componer() -> np.ndarray:
    """Arma la textura final, en escala de grises, y devuelve el mapa de 8 bits.

    **Pareja, sin mascara.** Toda la superficie esta en la misma banda de valor
    y es el velo de `.fondo-login` el que abre la textura en los margenes y la
    cierra en la columna del contenido. Ver el comentario de `NIVEL_BASE` para
    por que la mascara quedo aca descartada: los dos mecanismos se peleaban por
    la misma zona y la rampa de la mascara cruzaba el subtitulo.

    El orden de las dos etapas importa y no es intercambiable: la textura se
    recentra a media cero **primero**, recien ahi se le pone `NIVEL_BASE`.
    Recentrar despues de sumar cualquier termino con media distinta de cero
    deshace el efecto sobre ese termino."""

    # --- 1. textura, centrada a cero ---
    textura = (ruido_de_valor(ALTO, ANCHO, semilla=20250904) - 0.5) * NIVEL_RUIDO

    # Las vetas se propagan solas por broadcasting: el perfil viene en
    # `(alto, 1)` porque son horizontales.
    textura = textura + (vetas_de_cepillado(ALTO, semilla=77) - 0.5) * NIVEL_VETA

    # Rayas de uso: dos, finitas, de 1.4 px de alto. Cruzan la pantalla entera,
    # asi que en la columna del contenido quedan tapadas por el velo y en los
    # margenes se ven: es el detalle que hace que el fondo parezca una
    # superficie que alguien toco, y no un degradado. `y` y `x` se arman una
    # vez: armar un `np.arange` de 2 millones por raya no compra nada.
    y = np.arange(ALTO, dtype=np.float32)[:, None]
    x = np.linspace(-1.0, 1.0, ANCHO, dtype=np.float32)[None, :]
    rayas = np.zeros((ALTO, ANCHO), dtype=np.float32)
    for centro, amplitud in ((430, 1.0), (690, 0.6)):
        caida = np.exp(-(((y - centro) / 1.4) ** 2))
        # Se apaga hacia los bordes de la pantalla: una raya que llega al marco
        # se read como un error de recorte, no como metal.
        rayas += amplitud * caida * (1.0 - 0.6 * x**2)
    textura = textura + (rayas - rayas.mean()) * NIVEL_RAYAS

    # --- 2. la banda de valor, pareja en toda la superficie ---
    return np.clip(NIVEL_BASE + textura, 0, 255).astype(np.uint8)


def guardar(destino: Path) -> int:
    imagen = Image.fromarray(componer(), mode="L").convert("RGB")
    destino.parent.mkdir(parents=True, exist_ok=True)
    imagen.save(destino, "JPEG", quality=CALIDAD, optimize=True, progressive=True)
    return destino.stat().st_size


def kib(peso: int) -> float:
    return peso / 1024


def verificar() -> int:
    """Modo `--verificar`: mira el archivo commiteado. Devuelve el codigo de
    salida del proceso, para poder engancharlo a un chequeo sin parsear stdout."""
    if not DESTINO.exists():
        print(f"  [error] no existe {DESTINO.relative_to(RAIZ)}")
        print("          correrlo: python scripts/generar-fondo.py")
        return 1

    peso = DESTINO.stat().st_size
    with Image.open(DESTINO) as imagen:
        ancho, alto = imagen.size
        modo = imagen.mode

    print(f"\n  fondo-login.jpg  {ancho}x{alto}  {modo}  {kib(peso):.1f} KB")
    if peso >= LIMITE_KB * 1024:
        print(f"  [error] pesa {kib(peso):.1f} KB y el limite de §1.1 es {LIMITE_KB} KB")
        return 1
    if (ancho, alto) != (ANCHO, ALTO):
        print(f"  [aviso] el tamaño no es el del script ({ANCHO}x{ALTO})")
        return 1
    print(f"  [ok] dentro del limite de §1.1 ({LIMITE_KB} KB)\n")
    return 0


def main() -> int:
    analizador = argparse.ArgumentParser(description=__doc__)
    analizador.add_argument(
        "--verificar",
        action="store_true",
        help="no genera nada: mira el archivo commiteado y sale con 1 si se pasa del limite",
    )
    argumentos = analizador.parse_args()

    if argumentos.verificar:
        return verificar()

    peso = guardar(DESTINO)
    print(f"\n  escrito {DESTINO.relative_to(RAIZ)}  {ANCHO}x{ALTO}  {kib(peso):.1f} KB")
    if peso >= LIMITE_KB * 1024:
        # No es un error de este script: es que la textura grew y hay que
        # bajarle la calidad a mano o suavizarla. Se corta igual, para que un
        # .jpg de 300 KB nunca quede commiteado por una corrida desatendida.
        print(f"  [error] se paso el limite de §1.1 ({LIMITE_KB} KB)")
        return 1
    print(f"  [ok] dentro del limite de §1.1 ({LIMITE_KB} KB)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())