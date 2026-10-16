import type { ReactNode } from 'react';
import type { Permission } from '@tvmf/shared';
import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { permissionBlocked } from '@tvmf/shared';
import { useAuth } from '../auth';

export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can, me } = useAuth();
  if (!can(permission)) {
    const switchedOff = permissionBlocked(me?.disabledFeatures, permission);
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Not available</MessageBarTitle>
          {switchedOff ? 'This area is switched off on this installation.' : 'Your role does not have access to this area.'}
        </MessageBarBody>
      </MessageBar>
    );
  }
  return <>{children}</>;
}
