import type { Request } from 'express';

/**
 * Quién hizo una operación de **instalación** (`specs/01` §5.1).
 *
 * No lleva `idcliente` a propósito, y es lo que la distingue de
 * `SesionAdmin` (`registro-api/admin.types.ts`): una operación de instalación no
 * es de ningún tenant, y un tipo que aceptara un `idcliente` invitaría a usarlo
 * para autorizar algo. El caso real es el operador de la casa que administra
 * Tourniquet sin administrar ningún cliente.
 *
 * El `idusuario` es el que va a `aud_login`: la rotación la escribe **una
 * persona**, no "sistema" (`specs/01` §7).
 */
export interface Operador {
  idusuario: string;
  usuario: string;
  nombre: string;
}

export type RequestConOperador = Request & { operador: Operador };
