import { CanActivate, ExecutionContext, Injectable, NotFoundException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { disabledFeatures } from '@tvmf/db';
import type { PlatformFeature } from '@tvmf/shared';
import { InjectDb, type Db } from '../db/db.module';

const KEY = 'platform-feature';

/**
 * Marks a controller (or a route) as belonging to an optional area that a Super Admin can switch off for the installation
 * (Administration > Platform settings > Menus and features). While it is off the route answers "not found", as if it did not exist.
 */
export const RequireFeature = (feature: PlatformFeature) => SetMetadata(KEY, feature);

/** Global guard behind `@RequireFeature`. Reads the setting through the shared 30-second cache (a save in this process takes effect at once). */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectDb() private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<PlatformFeature | undefined>(KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!feature) return true;
    if ((await disabledFeatures(this.db)).includes(feature)) throw new NotFoundException('Not found');
    return true;
  }
}
