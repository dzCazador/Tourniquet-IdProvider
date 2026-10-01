import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ESQUEMA_ENTORNO, RUTAS_ENV } from './config/env.schema';
import { cat_clienteModule } from './cat_cliente/cat_cliente.module';
import { cat_aplicacionModule } from './cat_aplicacion/cat_aplicacion.module';
import { cat_cliente_aplicacionModule } from './cat_cliente_aplicacion/cat_cliente_aplicacion.module';
import { cat_base_datosModule } from './cat_base_datos/cat_base_datos.module';
import { idn_usuarioModule } from './idn_usuario/idn_usuario.module';
import { idn_usuario_clienteModule } from './idn_usuario_cliente/idn_usuario_cliente.module';
import { idn_usuario_cliente_aplicacionModule } from './idn_usuario_cliente_aplicacion/idn_usuario_cliente_aplicacion.module';
import { tok_sesionModule } from './tok_sesion/tok_sesion.module';
import { tok_autorization_codeModule } from './tok_autorization_code/tok_autorization_code.module';
import { tok_refresh_tokenModule } from './tok_refresh_token/tok_refresh_token.module';
import { tok_clave_firmaModule } from './tok_clave_firma/tok_clave_firma.module';
import { aud_loginModule } from './aud_login/aud_login.module';
import { ClavesModule } from './claves/claves.module';
import { AuthModule } from './auth/auth.module';
import { OidcModule } from './oidc/oidc.module';
import { RegistroModule } from './registro/registro.module';
import { RegistroApiModule } from './registro-api/registro-api.module';
import { MarcaModule } from './marca/marca.module';

@Module({
  imports: [
    // `isGlobal` para no tener que importar el modulo en cada feature, y
    // `validationSchema` para que el entorno se valide tambien DENTRO de Nest.
    // Es una segunda puerta: `main.ts` ya valida antes de crear la app (para
    // poder dar un mensaje legible), pero si algo levanta `AppModule` por otra
    // via, esta sigue estando.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: RUTAS_ENV,
      validationSchema: ESQUEMA_ENTORNO,
      validationOptions: { abortEarly: false, allowUnknown: true, convert: true },
    }),
    cat_clienteModule,
    cat_aplicacionModule,
    cat_cliente_aplicacionModule,
    cat_base_datosModule,
    idn_usuarioModule,
    idn_usuario_clienteModule,
    idn_usuario_cliente_aplicacionModule,
    tok_sesionModule,
    tok_autorization_codeModule,
    tok_refresh_tokenModule,
    tok_clave_firmaModule,
    aud_loginModule,
    ClavesModule,
    AuthModule,
    // Global: da `PrismaService` a todos los modulos. Va al final para que el
    // resto ya este declarado cuando Nest resuelva las dependencias.
    PrismaModule,
    OidcModule,
    RegistroModule,
    // `GET /marca`: nombre y tema del cliente, publico y de solo lectura
    // (`fase-10`). Es lo unico que se puede pedir sin sesion y por eso va
    // declarado aparte, con su modulo propio.
    MarcaModule,
    // Panel `admin_identidad` (Fase 08). Va aparte de `RegistroModule` porque es
    // de escritura y de alcance por tenant: ver el comentario del modulo.
    RegistroApiModule,
  ],
})
export class AppModule {}