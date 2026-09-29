import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as helmet from 'helmet';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { RUTAS_ENV, describirErrores, validarEntorno } from './config/env.schema';

// 1. Cargar el `.env` antes de validar. `ConfigModule` también lo carga, pero
//    recién cuando Nest construye el modulo, y para entonces el chequeo de
//    abajo ya corrio. dotenv NO pisa variables que ya existan en el entorno, así
//    que en produccion (donde la master key llega del gestor de secretos) gana
//    el entorno real y el `.env` es un no-op. Se usa `RUTAS_ENV` para que la
//    ruta no dependa del directorio de trabajo.
dotenv.config({ path: RUTAS_ENV });

async function bootstrap() {
  // 2. Validar ACÁ, antes de `NestFactory.create`. La razón es la misma de
  //    siempre: si se dejara para el arranque de Nest, una variable faltante
  //    sale como un fallo de inicialización de dependencias, que no dice qué
  //    variable falta ni cómo se arregla. Este bloque no depende de Nest, así
  //    que corta limpio.
  let entorno;
  try {
    entorno = validarEntorno();
  } catch (error) {
    const detalles = describirErrores(error);
    console.error('\n  [arranque abortado] El entorno no es valido:\n');
    for (const linea of detalles) {
      console.error(`  ${linea}`);
    }
    console.error('\n  Copiar .env.example a .env y completar. Para la master key:');
    console.error('      npm run generar:clave\n');
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.use(
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    }),
  );

  // Lista de origenes exactos, nunca `*` (`specs/01` §4). Vacio = CORS
  // deshabilitado, que es el estado correcto mientras no haya portal.
  const origenes = (config.get<string>('CORS_ORIGIN') ?? '')
    .split(',')
    .map((origen) => origen.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: origenes.length > 0 ? origenes : false,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
      credentials: true,
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(entorno.PORT);
  console.log(`Application running on: ${await app.getUrl()}`);
}
bootstrap().catch((err) => {
  console.error('Failed to bootstrap:', err);
  process.exit(1);
});
