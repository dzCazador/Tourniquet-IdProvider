import Link from 'next/link';
import { Sello } from '../ornaments/Sello';

/**
 * `PlacaApp`: la tarjeta de una app en el lanzador.
 *
 * Es un `<Link>` y no un `<a>`: el destino es interno (`/apps/puerta?app=...`), y
 * con `next/link` la navegacion no recarga el bundle entero. Lo que **no** esta en
 * el componente es la `redirect_uri` de la app ni nada del authorize: la tarjeta
 * lleva a la pantalla de puerta, y de ahi sale el viaje. Esa separacion es la que
 * hace que el lanzador no pueda autorizar nada (`specs/01` §1.2).
 *
 * El texto de la placa, de arriba hacia abajo, es el que el usuario necesita para
 * decidir si entra:
 *
 *   1. el **nombre** de la app, que es lo que busca;
 *   2. el `codigo`, que es dato y no adorno (es el `aud` del token, y sirve para
 *      distinguir dos apps del mismo nombre);
 *   3. la **base** de la que va a leer los datos, en lenguaje llano. El nombre de la
 *      base y nunca el host, nunca el usuario, nunca la credencial
 *      (`specs/01` §6, trampa 4 de la fase 07).
 *
 * El tema es **medio** en la placa (`estetica-tourniquet.md` §2): marco grabado y
 * sello, y **nada** de textura en el texto. La placa es opaca (`bg-tinta-alta`), que
 * es lo que sostiene el contraste del texto contra el fondo con texturas del
 * lanzador.
 */
export interface AppLanzador {
  codigo: string;
  nombre: string;
  /** Nombre de la base de datos de la app en este cliente, o `null`. */
  base: string | null;
  /** URL registrada de arranque (`cat_aplicacion.url_inicio`). */
  inicio: string;
}

export function PlacaApp({ app }: { app: AppLanzador }) {
  return (
    <Link
      href={`/apps/puerta?app=${encodeURIComponent(app.codigo)}`}
      className="foco-brasa group relative block rounded-placa bg-tinta-alta p-5 placa-marco transition-colors duration-150 hover:bg-hierro"
    >
      {/*
        El sello va arriba a la derecha. Su `role="img"` con nombre ("RHPro: sesión
        activa") es correcto **suelto** —en `/mi-cuenta`, donde sí marca el estado
        de una sesión— pero dentro de una tarjeta de link sobra: el lector ya anuncia
        el link con el nombre de la app, y "sesión activa" leído justo antes de
        "Entrar" confunde (parece que la sesión del portal está activa, que además
        es cierto y no es el dato). Por eso va con `aria-hidden` acá, y el `Sello`
        conserva su nombre para el otro uso.
      */}
      <span aria-hidden><Sello codigo={app.codigo} estado="activa" diametro={40} className="absolute right-4 top-4" /></span>


      <h3 className="pr-12 font-titulo text-lg font-normal text-hueso">{app.nombre}</h3>

      <p className="mt-1 font-codigo text-menor text-plata">{app.codigo}</p>

      {app.base ? (
        <p className="mt-4 font-interfaz text-menor text-plata">
          Lee los datos de <span className="text-hueso">{app.base}</span>
        </p>
      ) : (
        <p className="mt-4 font-interfaz text-menor text-plata">Sin base de datos propia</p>
      )}

      {/*
        El "Entrar" del pie es texto con `group-hover`, no un boton: la placa entera
        es el link, y un boton dentro de un link es un control anidado (un fallo de
        accesibilidad) y dos tabulaciones para la misma acción.
      */}
      <p className="mt-4 font-interfaz text-chico text-hueso opacity-70 transition-opacity duration-150 group-hover:opacity-100">
        Entrar
      </p>
    </Link>
  );
}
