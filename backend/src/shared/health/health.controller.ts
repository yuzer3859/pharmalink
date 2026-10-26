import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
} from '@nestjs/terminus';
import { Public } from '../rbac/public.decorator';
import { PrismaHealthIndicator } from './prisma.health';

/**
 * Liveness and readiness probes. Public: orchestrators, load balancers and uptime monitors call
 * them without a token, so the global `JwtAuthGuard` must let them through. Unauthenticated does
 * not mean internet-facing: restrict who can reach them at the network/ingress layer.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PrismaHealthIndicator,
  ) {}

  /** Liveness: process is up. Cheap, no dependencies. */
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies (DB) are reachable. */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db.pingCheck('database')]);
  }
}
