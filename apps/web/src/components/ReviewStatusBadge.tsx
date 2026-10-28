import { Badge } from '@fluentui/react-components';
import type { DiscoveryStatus } from '@tvmf/shared';

const COLOR: Record<DiscoveryStatus, 'informative' | 'warning' | 'success'> = {
  draft: 'informative',
  submitted: 'warning',
  accepted: 'success',
};

/** A site's Site Data review status, with how many changes were made since it was submitted. */
export function ReviewStatusBadge({ status, pendingChanges = 0 }: { status: DiscoveryStatus; pendingChanges?: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <Badge appearance="tint" color={COLOR[status]}>
        {status}
      </Badge>
      {pendingChanges > 0 && (
        <Badge appearance="filled" color="danger" title="Changes made after this site was submitted that have not been reviewed yet">
          {pendingChanges} changed since submitted
        </Badge>
      )}
    </span>
  );
}
