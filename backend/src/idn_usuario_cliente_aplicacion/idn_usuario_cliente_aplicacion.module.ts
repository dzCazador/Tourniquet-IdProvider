import { Module } from '@nestjs/common';

/**
 * Modulo de `idn_usuario_cliente_aplicacion`. La base es global (`PrismaModule`): no se declara
 * `PrismaService` aca porque Nest instancia un provider por modulo, y repetirlo
 * abriria un pool de conexiones por tabla.
 */
@Module({})
export class idn_usuario_cliente_aplicacionModule {}
