import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AplicacionService } from './aplicacion.service';
import { generarCode, sha256Hex } from './codigos';
import { CodigoErrorOauth, ErrorOidc } from './errores';
import { ContextoSesion, SesionService } from './sesion.service';
import { CODE_TTL_SEG, enSegundos } from './vidas';

export const SCOPES_SOPORTADOS = ['openid', 'profile', 'email'] as const;

/** Longitudes de RFC 7636 §4.1 para `code_challenge`. */
const MIN_CHALLENGE = 43;
const MAX_CHALLENGE = 128;

export interface PeticionAuthorize {
  client_id: string | null;
  redirect_uri: string | null;
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  response_type: string | null;
  scope: string | null;
}

export interface ResultadoAuthorize {
  url: string;
}

/**
 * `GET /oidc/authorize`: valida el pedido y, si hay sesion central, emite un
 * authorization code de un solo uso.
 *
 * **El orden de las validaciones no es arbitrario.** Es lo que evita filtrar
 * informacion y lo que evita el redirect abierto:
 *
 *   1. `response_type`: si no es `code`, se responde en el request. Todavia no
 *      hay ningun URI validado a donde mandar al usuario.
 *   2. `client_id` existe y esta activa. Sin app no hay a que auditar ni que
 *      `aud` emitir.
 *   3. `redirect_uri` **exacto**. Recien aca el `redirect_uri` es confiable, y
 *      desde este punto los errores se pueden devolver redirigiendo. Antes de
 *      esta comprobacion, un error que se mande por redireccion es un redirect
 *      abierto: el atacante elige el destino.
 *   4. `state` presente. Se refleja, no se valida: es del cliente, y lo unico
 *      que se exige es que exista para poder devolverlo.
 *   5. PKCE: `code_challenge` + `S256`. **Sin PKCE no hay code**, sin excepcion
 *      para "clientes internos".
 *   6. `scope` ⊆ soportados.
 *   7. Sesion central viva. Sin sesion no es un error: se manda al login del
 *      portal con un `returnTo`.
 *   8. El usuario esta habilitado para esa app, y la app existe para ese
 *      cliente.
 */
@Injectable()
export class AuthorizeService {
  private readonly logger = new Logger(AuthorizeService.name);
  private readonly issuer: string;
  private readonly portalUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: AplicacionService,
    private readonly sesiones: SesionService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<string>('TQ_ISSUER').replace(/\/+$/, '');
    this.portalUrl = (config.get<string>('TQ_PORTAL_URL') ?? '').replace(/\/+$/, '');
  }

  async autorizar(
    peticion: PeticionAuthorize,
    ctx: ContextoSesion & { sidPortal: string | null; urlAuthorize: string },
  ): Promise<ResultadoAuthorize> {
    // --- 1. response_type -------------------------------------------------
    if (peticion.response_type !== 'code') {
      throw new ErrorOidc('unsupported_response_type');
    }

    // --- 2. client_id -----------------------------------------------------
    if (!peticion.client_id) {
      throw new ErrorOidc('invalid_request');
    }
    const app = await this.apps.activa(peticion.client_id);
    if (!app) {
      // Inexistente e inactiva se responden igual: distinguirlos permitiria
      // enumerar el catalogo de apps.
      throw new ErrorOidc('unauthorized_client');
    }

    // --- 3. redirect_uri EXACTO -------------------------------------------
    if (!peticion.redirect_uri) {
      throw new ErrorOidc('invalid_request');
    }
    if (!this.apps.redirectRegistrado(app, peticion.redirect_uri)) {
      // Sin redireccion, jamas (trampa 1 de la Fase 03). Mandar el `error` a un
      // URI no validado seria un redirect abierto.
      throw new ErrorOidc('invalid_request');
    }

    // Desde aca el `redirect_uri` ya es confiable: los errores pueden viajar por
    // el, con el `state` del cliente, que es la forma que el RFC pide.
    const error = (codigo: CodigoErrorOauth, conState = true): ErrorOidc =>
      new ErrorOidc(codigo, {
        uri: peticion.redirect_uri as string,
        state: conState ? (peticion.state ?? undefined) : undefined,
      });

    // --- 4. state ---------------------------------------------------------
    if (!peticion.state) {
      throw error('invalid_request', false);
    }

    // --- 5. PKCE S256 -----------------------------------------------------
    if (!peticion.code_challenge) {
      throw error('invalid_request');
    }
    if (peticion.code_challenge_method !== 'S256') {
      // `plain` existe en el RFC y NO se implementa: sin SHA-256 el challenge no
      // protege el canje de un atacante que intercepte el code.
      throw error('invalid_request');
    }
    if (
      peticion.code_challenge.length < MIN_CHALLENGE ||
      peticion.code_challenge.length > MAX_CHALLENGE ||
      !/^[A-Za-z0-9\-._~]+$/.test(peticion.code_challenge)
    ) {
      throw error('invalid_request');
    }

    // --- 6. scope ---------------------------------------------------------
    const scope = this.validarScope(peticion.scope);
    if (scope === null) {
      throw error('invalid_scope');
    }

    // --- 7. sesion central ------------------------------------------------
    const sesionPortal = ctx.sidPortal ? await this.sesiones.viva(ctx.sidPortal) : null;
    if (!sesionPortal) {
      return this.redirigirAlLogin(ctx.urlAuthorize);
    }

    // --- 8. habilitacion y pertenencia de la app al cliente ---------------
    const habilitada = await this.prisma.idn_usuario_cliente_aplicacion.findUnique({
      where: {
        idusuario_idcliente_idaplicacion: {
          idusuario: sesionPortal.idusuario,
          idcliente: sesionPortal.idcliente,
          idaplicacion: app.codigo,
        },
      },
      select: { idusuario: true },
    });

    if (!habilitada) {
      throw error('access_denied');
    }

    if (!(await this.apps.perteneceAlCliente(sesionPortal.idcliente, app.codigo))) {
      throw error('unauthorized_client');
    }

    // --- Emision ----------------------------------------------------------
    const sesion = await this.sesiones.sesionDeApp(
      sesionPortal.idusuario,
      sesionPortal.idcliente,
      app.codigo,
      sesionPortal.amr,
      ctx,
    );

    const code = generarCode();
    const ahora = new Date();

    await this.prisma.tok_autorization_code.create({
      data: {
        sid: sesion.sid,
        idaplicacion: app.codigo,
        code_hash: sha256Hex(code),
        code_challenge: peticion.code_challenge,
        method: 'S256',
        redirect_uri: peticion.redirect_uri,
        // El `state` tambien va hasheado: lo elige el cliente, pero no tiene por
        // que quedar en claro en una base de la que se haga backup (a veces
        // trae datos de la sesion del cliente).
        state_hash: sha256Hex(peticion.state),
        creado_en: ahora,
        expira_en: enSegundos(CODE_TTL_SEG, ahora),
      },
    });

    this.logger.log(
      `code emitido app=${app.codigo} cliente=${sesion.idcliente} ` +
        `sid=${sesion.sid.slice(0, 8)} scope=${scope}`,
    );

    return { url: agregarParametros(peticion.redirect_uri, { code, state: peticion.state }) };
  }

  /**
   * Sin sesion central no hay error: el usuario va al login del portal y
   * vuelve. El `returnTo` es la URL completa del authorize, y lo valida el
   * backend del portal, no el navegador: comparar por prefijo en el front seria
   * un open redirect (trampa 3 de la Fase 04).
   */
  private redirigirAlLogin(urlAuthorize: string): ResultadoAuthorize {
    if (!this.portalUrl) {
      throw new ErrorOidc('portal_no_configurado');
    }
    return { url: `${this.portalUrl}/login?returnTo=${encodeURIComponent(urlAuthorize)}` };
  }

  /** Subconjunto de los scopes soportados, o `null` si pide alguno raro. */
  private validarScope(scope: string | null): string | null {
    const pedidos = (scope ?? '').split(/\s+/).filter(Boolean);
    if (pedidos.length === 0) {
      return 'openid';
    }
    const soportados = new Set<string>(SCOPES_SOPORTADOS);
    if (pedidos.some((s) => !soportados.has(s))) {
      return null;
    }
    return [...new Set(pedidos)].join(' ');
  }

  /** `issuer` ya normalizado, para el documento de discovery. */
  get emisor(): string {
    return this.issuer;
  }
}

/**
 * Agrega parametros a una URL conservando los que ya tenia.
 *
 * `URL` + `searchParams` y no concatenar a mano: el `redirect_uri` registrado
 * puede traer query propia (`?tab=inicio`) y un `&` a mano rompe con el `?` que
 * ya estaba. El `state` va literal: es opaco del cliente y se refleja.
 */
export function agregarParametros(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [clave, valor] of Object.entries(params)) {
    url.searchParams.set(clave, valor);
  }
  return url.toString();
}

/**
 * Lee un parametro de query que tiene que ser unico.
 *
 * Un parametro repetido (`?state=a&state=b`) no es algo que se pueda adivinar:
 * se rechaza. Express lo entrega como array, y si se tomara el primer elemento
 * el cliente y el servidor podrian no estar hablando del mismo `state`.
 */
export function paramUnico(query: Record<string, unknown>, nombre: string): string | null {
  const valor = query[nombre];
  if (valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new ErrorOidc('invalid_request');
  }
  return valor;
}
