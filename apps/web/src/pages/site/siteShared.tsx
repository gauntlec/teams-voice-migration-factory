import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Button, Text, tokens } from '@fluentui/react-components';
import { LinkRegular } from '@fluentui/react-icons';
import { type DiscoverySiteOverview } from '@tvmf/shared';
import { api, ApiError } from '../../api';
import { type Row } from '../../components/records';

export interface StaffMember {
  id: string;
  displayName: string;
  role: string;
}

export interface SiteSummary {
  site: {
    id: string;
    sitecode: string;
    name: string | null;
    address: string | null;
    country: string | null;
    region: string | null;
  };
  status: 'draft' | 'submitted' | 'accepted';
  callingPolicies: (Row & { name: string })[];
  numberSummary: { total: number; available: number; reserved: number; assigned: number };
  overview: DiscoverySiteOverview;
  assignedStaff: StaffMember[];
}

export const TABS = [
  'overview',
  'ranges',
  'numbers',
  'users',
  'caps',
  'resource-accounts',
  'network',
  'flows',
] as const;

export type TabKey = (typeof TABS)[number];

/** Last 10 significant digits — for loosely matching a requested vs assigned number. */
export const numKey = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);

/**
 * A wizard-captured Call flows row is "stale" once it's been edited again
 * after its last import - discovery_flows.updated_at bumps on every PATCH
 * (including the wizard's own "Save changes"), while imported_at only
 * moves when BuildService.importFlowWizard runs, so a strictly-later
 * updated_at means Design & Build hasn't seen the newest answers yet.
 */
export function isFlowStale(r: Row): boolean {
  if (!r.imported_at || !r.updated_at) return false;
  return new Date(r.updated_at as string).getTime() > new Date(r.imported_at as string).getTime();
}

export const TAB_LABEL: Record<TabKey, string> = {
  overview: 'Overview',
  ranges: 'Number ranges',
  numbers: 'Numbers',
  users: 'Users',
  caps: 'Common area phones',
  'resource-accounts': 'Resource accounts',
  network: 'Network (E911)',
  flows: 'Call flows',
};

/**
 * "Link to tenant" — matches every unlinked Data Collection user for this site
 * to the tenant user with the same UPN (from the last Discovery run).
 */
export function RelinkUsersButton({
  base,
  siteId,
  disabled,
  onDone,
}: {
  base: string;
  siteId: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const relink = useMutation({
    mutationFn: () =>
      api<{ linked: number; unmatched: number }>(`${base}/users/relink`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId }),
      }),
    onSuccess: (r) => {
      setMsg(
        `Linked ${r.linked}` +
          (r.unmatched ? ` · ${r.unmatched} with no match in the last Discovery run` : ''),
      );
      onDone();
      setTimeout(() => setMsg(null), 6000);
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Link failed'),
  });
  return (
    <>
      <Button
        size="small"
        icon={<LinkRegular />}
        disabled={disabled || relink.isPending}
        onClick={() => {
          setMsg(null);
          relink.mutate();
        }}
        title="Link users to the matching tenant user by UPN"
      >
        {relink.isPending ? 'Linking…' : 'Link to tenant'}
      </Button>
      {msg && (
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          {msg}
        </Text>
      )}
    </>
  );
}
