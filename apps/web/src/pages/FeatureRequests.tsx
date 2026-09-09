import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  CheckmarkRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import {
  FEATURE_AREAS,
  FEATURE_PRIORITIES,
  FEATURE_PRIORITY_LABELS,
  FEATURE_STATUSES,
  FEATURE_STATUS_LABELS,
  ROLES,
  type FeatureArea,
  type FeaturePriority,
  type FeatureRequest,
  type FeatureStatus,
  type Role,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Page } from '../components/Page';

/* --------------------------------- styles --------------------------------- */

const useStyles = makeStyles({
  board: {
    display: 'flex',
    ...shorthands.gap('12px'),
    alignItems: 'flex-start',
    overflowX: 'auto',
    ...shorthands.padding('4px', '2px', '12px'),
  },
  column: {
    flex: '0 0 300px',
    width: '300px',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'calc(100vh - 210px)',
  },
  columnOver: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorNeutralBackground2Hover },
  columnHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('10px', '12px'),
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  columnBody: {
    display: 'flex',
    flexDirection: 'column',
    ...shorthands.gap('8px'),
    ...shorthands.padding('8px'),
    overflowY: 'auto',
  },
  card: {
    ...shorthands.padding('10px'),
    display: 'grid',
    ...shorthands.gap('6px'),
    cursor: 'grab',
  },
  cardTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, lineHeight: '1.3' },
  tags: { display: 'flex', ...shorthands.gap('4px'), flexWrap: 'wrap', alignItems: 'center' },
  cardFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.gap('4px'),
  },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, ...shorthands.padding('8px') },
  formSurface: { maxWidth: '680px', width: '92vw' },
  form: { display: 'grid', ...shorthands.gap('12px'), width: '100%' },
  formRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', ...shorthands.gap('12px') },
  guide: {
    ...shorthands.padding('10px', '12px'),
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  guideList: { ...shorthands.margin('4px', '0', '0'), ...shorthands.padding('0', '0', '0', '18px'), display: 'grid', ...shorthands.gap('2px') },
});

/* ----------------------------- prompt builder ----------------------------- */

const PRIORITY_COLOR: Record<FeaturePriority, 'danger' | 'warning' | 'informative' | 'subtle'> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'informative',
  low: 'subtle',
};

function buildClaudePrompt(f: FeatureRequest): string {
  const na = '_Not specified._';
  const lines: (string | null)[] = [
    `# Feature request: ${f.title}`,
    '',
    `- **Area:** ${f.area}`,
    `- **Priority:** ${FEATURE_PRIORITY_LABELS[f.priority]}`,
    `- **Affected roles:** ${f.affected_roles.length ? f.affected_roles.join(', ') : 'Not specified'}`,
    f.submitted_by_name ? `- **Requested by:** ${f.submitted_by_name}` : null,
    '',
    '## Problem / motivation',
    f.problem,
    '',
    '## Proposed solution / desired behaviour',
    f.proposal,
    '',
    '## Current behaviour',
    f.current_behavior || na,
    '',
    '## Example scenario',
    f.examples || na,
    '',
    '## Acceptance criteria',
    f.acceptance || na,
    '',
    '## Constraints / out of scope',
    f.constraints || na,
    '',
    '---',
    'Review how this works in the codebase today, raise anything ambiguous, then implement it following the repo conventions in `docs/ARCHITECTURE.md` (shared `DataTable`, `makeStyles` for styling, RBAC in `packages/shared/src/rbac.ts`, plain-SQL migrations, zod DTOs in `packages/shared/src/dto.ts`). Typecheck every workspace and build the web app before finishing. When it ships, set this feature request to "Deployed".',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* --------------------------------- form ---------------------------------- */

interface FormState {
  title: string;
  area: FeatureArea | '';
  priority: FeaturePriority;
  problem: string;
  proposal: string;
  current_behavior: string;
  examples: string;
  acceptance: string;
  constraints: string;
  affected_roles: Role[];
  decision_note: string;
}

const emptyForm: FormState = {
  title: '',
  area: '',
  priority: 'medium',
  problem: '',
  proposal: '',
  current_behavior: '',
  examples: '',
  acceptance: '',
  constraints: '',
  affected_roles: [],
  decision_note: '',
};

function toForm(f: FeatureRequest): FormState {
  return {
    title: f.title,
    area: f.area,
    priority: f.priority,
    problem: f.problem,
    proposal: f.proposal,
    current_behavior: f.current_behavior ?? '',
    examples: f.examples ?? '',
    acceptance: f.acceptance ?? '',
    constraints: f.constraints ?? '',
    affected_roles: f.affected_roles ?? [],
    decision_note: f.decision_note ?? '',
  };
}

function FeatureForm({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial?: FeatureRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const s = useStyles();
  const [v, setV] = useState<FormState>(initial ? toForm(initial) : emptyForm);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => setV((p) => ({ ...p, [k]: val }));

  const save = useMutation({
    mutationFn: () => {
      const base = {
        title: v.title.trim(),
        area: v.area || undefined,
        priority: v.priority,
        problem: v.problem.trim(),
        proposal: v.proposal.trim(),
        current_behavior: v.current_behavior.trim(),
        examples: v.examples.trim(),
        acceptance: v.acceptance.trim(),
        constraints: v.constraints.trim(),
        affected_roles: v.affected_roles,
      };
      return mode === 'create'
        ? api('/feature-requests', { method: 'POST', body: JSON.stringify(base) })
        : api(`/feature-requests/${initial!.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...base, decision_note: v.decision_note.trim() }),
          });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const missing =
    v.title.trim().length < 6 ||
    !v.area ||
    v.problem.trim().length < 20 ||
    v.proposal.trim().length < 20;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface className={s.formSurface}>
        <DialogBody>
          <DialogTitle>{mode === 'create' ? 'New feature request' : 'Edit feature request'}</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              {mode === 'create' && (
                <div className={s.guide}>
                  What you write here becomes the prompt an engineer hands to Claude Code, so be
                  specific. A strong request:
                  <ul className={s.guideList}>
                    <li>states the <b>goal and the pain</b> — what's wrong or missing, and why it matters</li>
                    <li>describes the <b>desired end state</b> concretely (what the user sees / can do, and where)</li>
                    <li>gives <b>one concrete example</b> — given X, when I do Y, then Z</li>
                    <li>lists <b>acceptance criteria</b> — the checks that mean "done"</li>
                    <li>calls out <b>constraints</b> — anything that must not change or is out of scope</li>
                  </ul>
                  Keep each request to a single, coherent change — split big ideas into several.
                </div>
              )}

              <Field
                label="Title"
                required
                hint="One specific line, action-first. e.g. “Let engineers bulk-import users from CSV”, not “improve users page”."
              >
                <Input value={v.title} maxLength={160} onChange={(_, d) => set('title', d.value)} />
              </Field>

              <div className={s.formRow}>
                <Field label="Area" required hint="Which part of the product this touches.">
                  <Dropdown
                    placeholder="Select…"
                    selectedOptions={v.area ? [v.area] : []}
                    value={v.area}
                    onOptionSelect={(_, d) => set('area', (d.optionValue ?? '') as FeatureArea)}
                  >
                    {FEATURE_AREAS.map((a) => (
                      <Option key={a} value={a}>
                        {a}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Priority" hint="Your view of urgency — an admin can adjust it.">
                  <Dropdown
                    selectedOptions={[v.priority]}
                    value={FEATURE_PRIORITY_LABELS[v.priority]}
                    onOptionSelect={(_, d) => set('priority', (d.optionValue as FeaturePriority) ?? 'medium')}
                  >
                    {FEATURE_PRIORITIES.map((p) => (
                      <Option key={p} value={p}>
                        {FEATURE_PRIORITY_LABELS[p]}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>

              <Field
                label="Problem / motivation"
                required
                hint="What's wrong or missing today, why it matters, and who feels the pain. 2–5 sentences."
              >
                <Textarea
                  value={v.problem}
                  resize="vertical"
                  rows={3}
                  onChange={(_, d) => set('problem', d.value)}
                />
              </Field>

              <Field
                label="Proposed solution / desired behaviour"
                required
                hint="Describe the end state concretely. If you have a preferred approach say so; if not, write “open to suggestions”."
              >
                <Textarea
                  value={v.proposal}
                  resize="vertical"
                  rows={3}
                  onChange={(_, d) => set('proposal', d.value)}
                />
              </Field>

              <Field
                label="Current behaviour"
                hint="What happens today, or “doesn't exist yet”. Helps Claude find the right code."
              >
                <Textarea
                  value={v.current_behavior}
                  resize="vertical"
                  rows={2}
                  onChange={(_, d) => set('current_behavior', d.value)}
                />
              </Field>

              <Field
                label="Example scenario"
                hint="Walk through one real case with real values: “Given a site with 200 numbers, when I click Export, then I get a CSV of…”."
              >
                <Textarea
                  value={v.examples}
                  resize="vertical"
                  rows={2}
                  onChange={(_, d) => set('examples', d.value)}
                />
              </Field>

              <Field
                label="Acceptance criteria"
                hint="A short checklist of testable outcomes. Claude verifies against these before calling it done."
              >
                <Textarea
                  value={v.acceptance}
                  resize="vertical"
                  rows={3}
                  onChange={(_, d) => set('acceptance', d.value)}
                />
              </Field>

              <Field
                label="Constraints / out of scope"
                hint="Anything that must not change or stay compatible, and what is explicitly NOT part of this request."
              >
                <Textarea
                  value={v.constraints}
                  resize="vertical"
                  rows={2}
                  onChange={(_, d) => set('constraints', d.value)}
                />
              </Field>

              <Field label="Affected roles" hint="Whose experience changes. Optional.">
                <Dropdown
                  multiselect
                  placeholder="Any / not sure"
                  selectedOptions={v.affected_roles}
                  value={v.affected_roles.join(', ')}
                  onOptionSelect={(_, d) => set('affected_roles', (d.selectedOptions as Role[]) ?? [])}
                >
                  {ROLES.map((r) => (
                    <Option key={r} value={r}>
                      {r}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              {mode === 'edit' && (
                <Field
                  label="Decision note"
                  hint="Why it was declined, or scheduling / triage notes. Shown on the card."
                >
                  <Textarea
                    value={v.decision_note}
                    resize="vertical"
                    rows={2}
                    onChange={(_, d) => set('decision_note', d.value)}
                  />
                </Field>
              )}

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" disabled={missing || save.isPending} onClick={() => save.mutate()}>
              {mode === 'create' ? 'Submit request' : 'Save changes'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* --------------------------------- card ---------------------------------- */

function RequestCard({
  f,
  canManage,
  onEdit,
  onMove,
  onDelete,
}: {
  f: FeatureRequest;
  canManage: boolean;
  onEdit: () => void;
  onMove: (status: FeatureStatus) => void;
  onDelete: () => void;
}) {
  const s = useStyles();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyText(buildClaudePrompt(f));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Card
      className={s.card}
      draggable={canManage}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', f.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className={s.cardTitle}>{f.title}</div>
      <div className={s.tags}>
        <Badge appearance="tint" color={PRIORITY_COLOR[f.priority]} size="small">
          {FEATURE_PRIORITY_LABELS[f.priority]}
        </Badge>
        <Badge appearance="outline" color="informative" size="small">
          {f.area}
        </Badge>
      </div>
      {f.decision_note && <Text className={s.meta}>Note: {f.decision_note}</Text>}
      <div className={s.cardFoot}>
        <Text className={s.meta}>
          {f.submitted_by_name ?? 'Unknown'} · {timeAgo(f.created_at)}
        </Text>
        <div style={{ display: 'flex', gap: 2 }}>
          <Button
            size="small"
            appearance="subtle"
            icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
            onClick={copy}
            title="Copy the prompt for Claude"
            aria-label="Copy the prompt for Claude"
          >
            {copied ? 'Copied' : 'Prompt'}
          </Button>
          {canManage && (
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<MoreHorizontalRegular />}
                  aria-label="More actions"
                />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem icon={<EditRegular />} onClick={onEdit}>
                    Edit…
                  </MenuItem>
                  {FEATURE_STATUSES.filter((st) => st !== f.status).map((st) => (
                    <MenuItem key={st} onClick={() => onMove(st)}>
                      Move to {FEATURE_STATUS_LABELS[st]}
                    </MenuItem>
                  ))}
                  <MenuItem icon={<DeleteRegular />} onClick={onDelete}>
                    Delete
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          )}
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------- page ---------------------------------- */

export function FeatureRequests() {
  const s = useStyles();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can('feature:manage');
  const canCreate = can('feature:create');

  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; f: FeatureRequest } | null>(
    null,
  );
  const [overCol, setOverCol] = useState<FeatureStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FeatureRequest | null>(null);

  const list = useQuery({
    queryKey: ['feature-requests'],
    queryFn: () => api<FeatureRequest[]>('/feature-requests'),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['feature-requests'] });

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeatureStatus }) =>
      api(`/feature-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/feature-requests/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(null);
      invalidate();
    },
  });

  const byStatus = useMemo(() => {
    const m = new Map<FeatureStatus, FeatureRequest[]>();
    for (const st of FEATURE_STATUSES) m.set(st, []);
    for (const f of list.data ?? []) m.get(f.status)?.push(f);
    return m;
  }, [list.data]);

  const actions: ReactNode = canCreate ? (
    <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialog({ mode: 'create' })}>
      New feature request
    </Button>
  ) : undefined;

  return (
    <Page
      title="Feature requests"
      subtitle="Ideas to improve the platform. An admin moves a card to “In development” to hand it to Claude Code; it returns to “Deployed” when the change ships."
      actions={actions}
    >
      {list.isLoading ? (
        <Spinner size="tiny" />
      ) : list.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>{(list.error as Error).message}</MessageBarBody>
        </MessageBar>
      ) : (
        <div className={s.board}>
          {FEATURE_STATUSES.map((st) => {
            const items = byStatus.get(st) ?? [];
            return (
              <div
                key={st}
                className={mergeClasses(s.column, overCol === st && s.columnOver)}
                onDragOver={(e) => {
                  if (!canManage) return;
                  e.preventDefault();
                  if (overCol !== st) setOverCol(st);
                }}
                onDragLeave={() => setOverCol((c) => (c === st ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverCol(null);
                  const id = e.dataTransfer.getData('text/plain');
                  const cur = (list.data ?? []).find((f) => f.id === id);
                  if (id && cur && cur.status !== st) move.mutate({ id, status: st });
                }}
              >
                <div className={s.columnHead}>
                  <span>{FEATURE_STATUS_LABELS[st]}</span>
                  <Badge appearance="tint" color="informative" size="small">
                    {items.length}
                  </Badge>
                </div>
                <div className={s.columnBody}>
                  {items.length === 0 ? (
                    <div className={s.empty}>Nothing here.</div>
                  ) : (
                    items.map((f) => (
                      <RequestCard
                        key={f.id}
                        f={f}
                        canManage={canManage}
                        onEdit={() => setDialog({ mode: 'edit', f })}
                        onMove={(status) => move.mutate({ id: f.id, status })}
                        onDelete={() => setConfirmDelete(f)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dialog?.mode === 'create' && (
        <FeatureForm mode="create" onClose={() => setDialog(null)} onSaved={invalidate} />
      )}
      {dialog?.mode === 'edit' && (
        <FeatureForm
          mode="edit"
          initial={dialog.f}
          onClose={() => setDialog(null)}
          onSaved={invalidate}
        />
      )}

      {confirmDelete && (
        <Dialog open onOpenChange={(_, d) => !d.open && setConfirmDelete(null)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete this feature request?</DialogTitle>
              <DialogContent>
                “{confirmDelete.title}” will be permanently removed. This cannot be undone.
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button
                  appearance="primary"
                  style={{ backgroundColor: tokens.colorPaletteRedBackground3 }}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(confirmDelete.id)}
                >
                  Delete
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </Page>
  );
}
