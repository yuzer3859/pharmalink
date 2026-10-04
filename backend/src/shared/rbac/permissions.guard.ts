import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from '../errors/api-exception';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { hasAllPermissions } from './permission-matcher';
import { PermissionCacheService } from './permission-cache.service';
import {
  AuthenticatedPrincipal,
  IPermissionResolver,
  PERMISSION_RESOLVER,
} from './rbac.types';

/**
 * Enforces @RequirePermissions on routes. Resolution order for the principal's permissions:
 *   1. permissions embedded on the authenticated principal (e.g. from the access token);
 *   2. the permission cache;
 *   3. a registered IPermissionResolver (Module 01), whose result is cached.
 * Routes without @RequirePermissions are allowed (auth is enforced by a separate auth guard).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cache: PermissionCacheService,
    @Optional()
    @Inject(PERMISSION_RESOLVER)
    private readonly resolver?: IPermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const principal = request.user;
    if (!principal?.userId) {
      throw ApiException.unauthenticated('Authentication required for this resource');
    }

    const granted = await this.resolveGranted(principal);

    if (!hasAllPermissions(granted, required)) {
      throw ApiException.forbidden('Insufficient permissions', { required });
    }
    return true;
  }

  private async resolveGranted(principal: AuthenticatedPrincipal): Promise<string[]> {
    if (principal.permissions && principal.permissions.length > 0) {
      return principal.permissions;
    }

    const cached = this.cache.get(principal.userId);
    if (cached) {
      return cached;
    }

    if (this.resolver) {
      const resolved = await this.resolver.resolvePermissions(principal.userId);
      this.cache.set(principal.userId, resolved);
      return resolved;
    }

    return [];
  }
}
