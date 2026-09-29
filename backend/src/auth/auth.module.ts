import { Module } from '@nestjs/common';
import { AuditoriaService } from './auditoria.service';
import { IdentidadService } from './identidad.service';
import { RateLimitService } from './rate-limit.service';

@Module({
  providers: [AuditoriaService, RateLimitService, IdentidadService],
  exports: [IdentidadService, RateLimitService, AuditoriaService],
})
export class AuthModule {}
