import { Module } from '@nestjs/common';
import { MarcaController } from './marca.controller';
import { MarcaService } from './marca.service';

/**
 * Modulo de la marca: el nombre del cliente y el tema con el que se pinta el
 * portal (`estetica-tourniquet.md` §11, `fase-10`).
 *
 * Vive solo y sin imports porque es lo unico del backend que se puede pedir sin
 * sesion, y esa diferencia es la que el modulo hace visible. No declara
 * `PrismaService`: `PrismaModule` es global, y repetir el provider abriria un
 * pool de conexiones por modulo.
 */
@Module({
  controllers: [MarcaController],
  providers: [MarcaService],
})
export class MarcaModule {}
