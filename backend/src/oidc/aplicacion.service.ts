import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface Aplicacion {
  codigo: string;
  nombre: string;
  tipo_cliente: string;
  redirect_uris_json: string;
  origenes_json: string;
  estado: string;
}

/**
 * Lectura del registro de aplicaciones (`cat_aplicacion`).
 *
 * Todo lo que sale de la base es **inventario de confianza**: la lista de
 * `redirect_uri` es la defensa contra el redirect abierto y la de
 * `origenes_json` la de CORS (`specs/01` §9). Por eso la comparacion de URIs
 * vive aqui y no en el controller: es el unico lugar donde se decide si un URI
 * es aceptable, para que ningun endpoint pueda saltarsela por su cuenta.
 */
@Injectable()
export class AplicacionService {
  constructor(private readonly prisma: PrismaService) {}

  async buscar(codigo: string): Promise<Aplicacion | null> {
    return this.prisma.cat_aplicacion.findUnique({ where: { codigo } });
  }

  /** App registrada y activa. Un `inactivo` es indistinguible de uno inexistente. */
  async activa(codigo: string): Promise<Aplicacion | null> {
    const app = await this.buscar(codigo);
    return app && app.estado === 'activo' ? app : null;
  }

  /**
   * Compara un `redirect_uri` contra los registrados: **igualdad de string
   * completo**. Sin wildcard, sin prefijo, sin normalizar esquema ni host ni
   * barra final.
   *
   * Esa austeridad es a proposito. Las comparaciones "lax" que se ven en otros
   * IdP (mismo host, mismo prefijo, ignorar mayusculas) existen por
   * compatibilidad con clientes viejos y acá no hay ningun cliente viejo: lo que
   * hacen es abrir la puerta a que un atacante registre su propio subdominio.
   * `specs/01` §9 lo pide asi y la trampa 1 de la Fase 03 lo repite.
   */
  redirectRegistrado(app: Aplicacion, uri: string): boolean {
    return this.uris(app).includes(uri);
  }

  /** Lista de `redirect_uri` parseada. Un JSON corrupto es lista vacia, no un `throw` en el camino del login. */
  uris(app: Aplicacion): string[] {
    return this.parsear(app.redirect_uris_json);
  }

  origenes(app: Aplicacion): string[] {
    return this.parsear(app.origenes_json);
  }

  private parsear(json: string): string[] {
    try {
      const valor: unknown = JSON.parse(json);
      return Array.isArray(valor) ? valor.filter((u): u is string => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * La app existe **para este cliente** (`cat_cliente_aplicacion`). Sin esta
   * fila el authorize responde `access_denied`: es lo que impide que un
   * miembro del cliente A entre con la app que el cliente B tiene registrada.
   */
  async perteneceAlCliente(idcliente: string, idaplicacion: string): Promise<boolean> {
    const vinculo = await this.prisma.cat_cliente_aplicacion.findUnique({
      where: { idcliente_idaplicacion: { idcliente, idaplicacion } },
      select: { idaplicacion: true },
    });
    return vinculo !== null;
  }
}
