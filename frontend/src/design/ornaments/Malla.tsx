/**
 * `Malla`: la textura de red de 24 px del fondo (`estetica-tourniquet.md` §5).
 *
 * Es un patron SVG en `data:` URI, no un componente: no tiene estado, no se
 * posiciona y lo unico que hace es estar de fondo. Como componente habria que
 * envolver cada superficie en un `<div>`, y el resultado seria el mismo patron con
 * dos capas de nodos de por medio.
 *
 * La opacidad es 0.04 y va en el `stroke-opacity` del patron, no en un
 * `opacity` encima: al 4 % sobre `tinta` la malla se ve como foil, y con un
 * `opacity` de contenedor el texto que estuviera arriba tambien bajaria (el texto
 * va en `tinta-alta`, que es opaca, asi que en el login no se nota; pero el mismo
 * componente se puede usar sobre una superficie con texto y en ese caso si se
 * notaria).
 */
export function Malla({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 ${className}`}
      style={{
        backgroundImage:
          'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\'%3E%3Cpath d=\'M24 0H0v24\' fill=\'none\' stroke=\'%23c8ccd4\' stroke-opacity=\'0.04\' stroke-width=\'1\'/%3E%3C/svg%3E")',
        backgroundRepeat: 'repeat',
      }}
    />
  );
}
