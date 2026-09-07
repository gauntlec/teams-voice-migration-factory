import type { ReactNode } from 'react';
import type { Permission } from '@tvmf/shared';
import { MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useAuth } from '../auth';

export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Not available</MessageBarTitle>
          Your role does not have access to this area.
        </MessageBarBody>
      </MessageBar>
    );
  }
  return <>{children}</>;
}
