import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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
  /**
   * Que sesion y que app produjo este `url`, para que el que llama pueda auditarlo
   * sin volver a consultar la base.
   *
   * Viene cuando se **emitio** un `code` (o sea, en el `consentir`). En los caminos
   * donde no se emitio nada —login, pantalla de consentimiento— viene `undefined`, y
   * no hay nada que auditar porque no ocurrio un ingreso: no se creo sesion de app.
   */
  emitido?: {
    idusuario: string;
    idcliente: string;
    idaplicacion: string;
  };
}

/**
 * Lo que la pantalla de consentimiento necesita para pintar los hechos.
 *
 * `base` es el **nombre** de la base de datos de la app en ese cliente
 * (`cat_base_datos.base`), nunca el host, nunca el usuario, nunca la credencial
 * (`specs/01` §6). Es lo unico que el usuario tiene motivo legitimo de saber antes
 * de entrar: a que datos va a acceder. Es `null` cuando la app no tiene base
 * inventariada, y eso no es un error: una app que no usa base de negocio no la
 * tiene.
 */
export interface DatosConsentimiento {
  app: { codigo: string; nombre: string };
  cliente: { codigo: string; nombre: string };
  base: string | null;
}

/**
 * `GET /oidc/authorize`: valida el pedido y, si hay sesion central, **prepara el
 * ingreso de la app**. El `code` se emite recien cuando el portal acepta el
 * consentimiento (`POST /oidc/consentir`, Fase 07).
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
 *
 * Todo esto se corre **dos veces** en un ingreso normal: una en el authorize y otra
 * en el `/oidc/consentir`, porque entre las dos pantallas hay un portal entero de
 * por medio. Es a proposito: el portal es codigo del cliente, y la unica forma de
 * que lo que se acepte sea exactamente lo que se pidio es volver a comprobarlo en
 * el servidor. Lo que NO se revalida (porque no se puede) es el `code_verifier`,
 * que vive en el navegador de la app: si el portal cambiara el challenge, el canje
 * falla por PKCE (`specs/01` §1.1).
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

  /**
   * Valida el pedido y devuelve la **URL a la que tiene que ir el navegador**: el
   * login del portal si no hay sesion, la pantalla de consentimiento si la hay.
   *
   * `consentida: true` saltea la pantalla y emite el `code`. El unico llamador que
   * lo pasa es `POST /oidc/consentir`.
   *
   * `exigirSesion: true` cambia el paso 7: sin sesion central **no** se redirige al
   * login sino que se responde `login_required`. Lo usa tambien el `consentir`, y
   * es lo que hace que "aceptar" no pueda usarse como una segunda puerta al
   * authorize: sin sesion, la aceptacion es un 401 y no una URL de destino. Sin
   * esto, un portal que navegara a la URL devuelta mandaria al usuario al login
   * creyendo que es la app, y el `code` se emitiria en el authorize que viene
   * después sin que nadie haya aceptado nada.
   */
  async autorizar(
    peticion: PeticionAuthorize,
    ctx: ContextoSesion & { sidPortal: string | null; urlAuthorize: string },
    opciones: { consentida?: boolean; exigirSesion?: boolean } = {},
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
      if (opciones.exigirSesion) {
        throw new ErrorOidc('login_required', null, HttpStatus.UNAUTHORIZED);
      }
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

    // --- 9 · Consentimiento (Fase 07) -------------------------------------
    //
    // Aca termina el authorize y arranca la pantalla de consentimiento. No se
    // emite nada todavia: el `code` sale de `POST /oidc/consentir`, que vuelve a
    // pasar por todo lo de arriba. Ver `specs/01` §1.1 para por que el
    // consentimiento es del IdP y no del lanzador.
    if (!opciones.consentida) {
      return { url: this.urlDeConsentimiento(peticion) };
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
        `sid=${sesion.sid.slice(0, 8)} scope=${scope} consentido=true`,
    );

    return {
      url: agregarParametros(peticion.redirect_uri, { code, state: peticion.state }),
      emitido: {
        idusuario: sesionPortal.idusuario,
        idcliente: sesionPortal.idcliente,
        idaplicacion: app.codigo,
      },
    };
  }

  /**
   * Hechos para pintar el consentimiento: que app es, de que cliente es y a que
   * base entra.
   *
   * No devuelve el `redirect_uri` ni el `code_challenge` a proposito: la pantalla
   * los tiene en su propia URL y no los necesita para mostrar nada. Lo que no se
   * puede es devolver **mas** de lo que el usuario ya va a ver, y por eso este
   * endpoint no acepta un `tenant` del cliente: el cliente es el de la sesion, y
   * el filtro de habilitacion va por esa sesion y no por el parametro.
   */
  async datosDeConsentimiento(
    clientId: string | null,
    ctx: ContextoSesion & { sidPortal: string | null },
  ): Promise<DatosConsentimiento> {
    if (!clientId) {
      throw new ErrorOidc('invalid_request');
    }

    const app = await this.apps.activa(clientId);
    if (!app) {
      // Igual que en el authorize: inexistente e inactiva son la misma respuesta,
      // para que el endpoint no sea un oraculo del catalogo de apps.
      throw new ErrorOidc('unauthorized_client');
    }

    const sesionPortal = ctx.sidPortal ? await this.sesiones.viva(ctx.sidPortal) : null;
    if (!sesionPortal) {
      throw new ErrorOidc('login_required', null, HttpStatus.UNAUTHORIZED);
    }

    if (!(await this.apps.perteneceAlCliente(sesionPortal.idcliente, app.codigo))) {
      throw new ErrorOidc('unauthorized_client');
    }

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
      throw new ErrorOidc('access_denied');
    }

    const [cliente, base] = await Promise.all([
      this.prisma.cat_cliente.findUnique({
        where: { codigo: sesionPortal.idcliente },
        select: { codigo: true, nombre: true },
      }),
      // El indice `UQ_cat_base_datos_cliente_aplicacion_activa` deja **una** base
      // activa por combinacion cliente+app (`specs/02` §4), asi que el `findFirst`
      // no es "el primero que encuentre": hay a lo sumo uno.
      this.prisma.cat_base_datos.findFirst({
        where: { idcliente: sesionPortal.idcliente, idaplicacion: app.codigo, estado: 'activo' },
        select: { base: true },
        orderBy: { codigo: 'asc' },
      }),
    ]);

    if (!cliente) {
      // Sesion huerfana: el cliente se dio de baja con la sesion abierta. Es un
      // `access_denied` y no un 500, porque desde afuera es indistinguible de "no
      // tenes acceso a eso".
      throw new ErrorOidc('access_denied');
    }

    return {
      app: { codigo: app.codigo, nombre: app.nombre },
      cliente: { codigo: cliente.codigo, nombre: cliente.nombre },
      base: base?.base ?? null,
    };
  }

  /**
   * URL de la pantalla de consentimiento del portal, con el pedido intacto.
   *
   * Los seis parametros viajan tal cual. Los que importan son `redirect_uri` y
   * `code_challenge`, y pueden ir en la URL sin que eso sea un agujero: el
   * `consentir` vuelve a comparar el `redirect_uri` **exacto** contra el registro
   * y a exigir el formato S256 del challenge, asi que un valor cambiado ahi falla
   * en el servidor; y un challenge cambiado hace fallar el canje por PKCE, porque
   * el `code_verifier` esta en el navegador de la app. El `state` viaja en la URL
   * y no en un almacen del navegador a proposito: es el valor que el portal tiene
   * que devolver tal cual, y la fuente que no se puede manipular en el camino es el
   * propio pedido original.
   */
  private urlDeConsentimiento(peticion: PeticionAuthorize): string {
    if (!this.portalUrl) {
      // Sin portal no hay donde mostrar el consentimiento, y no hay donde pedir la
      // clave tampoco. Es la misma falla que el login: sin `TQ_PORTAL_URL` el IdP
      // no tiene front, y se responde con el codigo del error en vez de emitir un
      // `code` que nadie autorizo.
      throw new ErrorOidc('portal_no_configurado');
    }

    const query = new URLSearchParams({
      response_type: peticion.response_type as string,
      client_id: peticion.client_id as string,
      redirect_uri: peticion.redirect_uri as string,
      state: peticion.state as string,
      code_challenge: peticion.code_challenge as string,
      code_challenge_method: 'S256',
      scope: peticion.scope ?? 'openid',
    });

    return `${this.portalUrl}/consentimiento?${query.toString()}`;
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
