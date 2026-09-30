import { Lamina } from '@/design/components/Lamina';
import { Boton } from '@/design/components/Boton';

/**
 * 404. Se genera con `output: 'export'`, asi que es el `404.html` que sirve el
 * web server para cualquier ruta desconocida. El mensaje es funcional y la
 * accion es volver al login: un 404 con tematica y sin salida es un callejon
 * sin salida decorado (`estetica-tourniquet.md` §7).
 */
export default function NoEncontrada() {
  return (
    <Lamina
      codigo="404"
      titulo="Esta pagina no existe."
      accion={
        <a href="/login">
          <Boton type="button">Ir al ingreso</Boton>
        </a>
      }
    >
      <p>Si llegaste desde una aplicacion, es probable que el enlace haya quedado viejo.</p>
    </Lamina>
  );
}
