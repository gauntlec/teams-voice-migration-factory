import { type SrAssistantInfo } from '../../components/RequestAssistant';
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { type DeploymentPreviewRow, type SrBuildKind, type SrClock, type SrChangeWindow, type SrStatus } from '@tvmf/shared';
import { type BuildTab } from '../BuildSiteWorkspace';
import { when, type RequestBuildInfo, type RequestDetail, type RequestEvent } from '../ServiceRequests';

export type PageTab = 'overview' | 'design' | 'deploy';

export const STEPS: SrStatus[] = ['new', 'planned', 'built', 'deployed'];

/** The Design & Build tab each request type is designed on. */
export const BUILD_TAB_FOR: Partial<Record<SrBuildKind, BuildTab>> = {
  user: 'users',
  cap: 'caps',
  call_queue: 'call-queues',
  auto_attendant: 'auto-attendants',
};

/** Build list query keys, refreshed when a row is linked or removed. */
export const BUILD_LIST_KEYS = ['users', 'caps', 'resource-accounts', 'shared-calling-policies', 'call-queues', 'auto-attendants'];

export const OBJECT_TYPE_LABEL: Record<DeploymentPreviewRow['objectType'], string> = {
  user: 'User',
  cap: 'Common area phone',
  resource_account: 'Resource account',
  call_queue: 'Call queue',
  auto_attendant: 'Auto attendant',
  shared_calling_policy: 'Shared calling policy',
};

export const GROUP_ORDER: DeploymentPreviewRow['objectType'][] = ['user', 'cap', 'resource_account', 'shared_calling_policy', 'call_queue', 'auto_attendant'];

export const RESULT_BADGE_COLOR: Record<string, 'success' | 'danger' | 'informative' | 'subtle'> = {
  applied: 'success',
  failed: 'danger',
  whatif: 'informative',
  skipped: 'subtle',
};

export const usePageStyles = makeStyles({
  steps: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXS },
  stepSep: { color: tokens.colorNeutralForeground4 },
  card: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3 },
  commands: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', margin: 0 },
  mono: { fontFamily: 'ui-monospace, monospace' },
  warningRow: {
    display: 'flex',
    alignItems: 'flex-start',
    columnGap: '4px',
    ...shorthands.borderRadius('4px'),
    ...shorthands.padding('2px', '6px'),
    marginTop: '4px',
    color: tokens.colorPaletteYellowForeground1,
    backgroundColor: tokens.colorPaletteYellowBackground2,
    fontSize: '12px',
    lineHeight: '16px',
  },
  groupHeaderCell: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  blockers: { margin: 0, paddingLeft: '20px', color: tokens.colorPaletteMarigoldForeground2 },
  waiting: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorPaletteYellowBorder1),
    backgroundColor: tokens.colorPaletteYellowBackground1,
  },
});

export interface RequestPayload {
  request: RequestDetail;
  events: RequestEvent[];
  build: RequestBuildInfo | null;
  sla: { response: SrClock; resolution: SrClock; target: { responseHours: number; resolveHours: number } };
  approval: { status: 'pending' | 'approved' | 'rejected'; by: string | null; at: string | null; note: string | null; approvers: string[]; canDecide: boolean } | null;
  /** Staff only: worth checking before work starts. */
  checks: string[];
  /** Staff only: the customer's change window. */
  changeWindow: SrChangeWindow | null;
  /** Staff only: assistants on this request. */
  agent?: SrAssistantInfo;
  /** Staff only: incidents this request is linked to. */
  incidents?: { id: string; reference: string; title: string; status: string; priority: string }[];
}
