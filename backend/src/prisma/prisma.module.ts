import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';

/**
 * Unica conexion a la base de control, para toda la app.
 *
 * `isGlobal` para que ningun modulo tenga que importarlo, y para que
 * `PrismaService` deje de aparecer en la lista de providers de cada modulo de
 * dominio. Antes estaba en quince: Nest instancia un provider **por modulo**, asi
 * que la app abria quince clientes de Prisma y quince pooles de conexiones contra
 * el mismo SQL Server, y cada modulo usaba el suyo (todos con la misma URL, por
 * eso no se notaba). Un pool solo es lo que se quiere en una instalacion chica
 * (D3 de `specs/00`); el limite de conexiones se controla en el servidor.
 *
 * La URL sale del esquema de entorno ya validado, no de `process.env`: es la
 * unica fuente y la que Joi chequeo al arrancar (ver `PrismaService`).
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: (config: ConfigService) =>
        new PrismaService(config.getOrThrow<string>('DATABASE_URL')),
      inject: [ConfigService],
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
