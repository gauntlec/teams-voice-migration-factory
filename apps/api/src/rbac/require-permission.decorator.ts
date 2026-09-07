import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@tvmf/shared';

export const REQUIRE_PERMISSION = 'rbac:permissions';

/** All listed permissions must be satisfied by the caller's role. */
export const RequirePermission = (...perms: Permission[]) =>
  SetMetadata(REQUIRE_PERMISSION, perms);
