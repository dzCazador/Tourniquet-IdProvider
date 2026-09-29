import { Module } from '@nestjs/common';

/**
 * Modulo de `tok_refresh_token`. La base es global (`PrismaModule`): no se declara
 * `PrismaService` aca porque Nest instancia un provider por modulo, y repetirlo
 * abriria un pool de conexiones por tabla.
 */
@Module({})
export class tok_refresh_tokenModule {}
