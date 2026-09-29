import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Acceso a la base de control. Unico punto de acceso a datos del backend.
 *
 * La URL se pasa **por parametro**, no por `process.env`. Es a proposito: el
 * cliente de Prisma carga solo los `.env` que encuentra junto a `schema.prisma`
 * (o sea, `backend/.env`), y ese `.env` se populateaba **antes** que el
 * `dotenv.config` de la app, sin que nadie lo pidiera. Con dos archivos de
 * entorno, el que ganaba era el equivocado y el canónico de `specs/00` §8.1 no
 * gobernaba nada. Pasando la URL desde el esquema de entorno, la única fuente es
 * la que ya valida Joi al arrancar.
 *
 * `new PrismaService()` sin argumento sigue funcionando (lee `DATABASE_URL` del
 * entorno, que es lo que hacen los scripts), pero la app siempre lo pasa.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor(url?: string) {
    super(url ? { datasources: { db: { url } } } : undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
