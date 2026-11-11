import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AddRegular,
  CalendarClockRegular,
  CallEndRegular,
  CallForwardRegular,
  ClockRegular,
  DeleteRegular,
  DialpadRegular,
  FlowRegular,
  MegaphoneRegular,
  PeopleTeamRegular,
  PersonRegular,
  SearchRegular,
  VoicemailRegular,
  WeatherSunnyRegular,
} from '@fluentui/react-icons';
import { Badge, Button, Dropdown, Field, Input, Option, Switch, Text, Textarea, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  AA_SUPPORTED_LANGUAGES,
  AA_TIME_ZONES,
  callFlowDefaultsForSite,
  newVisualGroup,
  onlyRingsAGroup,
  visualCallFlowProblem,
  visualFlowCanvas,
  visualFlowCreates,
  visualFlowSummary,
  visualHoursWords,
  visualStepWords,
  type VisualCallFlow,
  type VisualGroup,
  type VisualGroupEnd,
  type VisualMenuOption,
  type VisualOptionStep,
  type VisualPath,
  type VisualRinging,
  type VisualStep,
  type WizardTarget,
  type WizardWeeklyHours,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { WeeklyHoursEditor } from './AutoAttendantWizard';
import { CallFlowEditorCanvas } from './CallFlowDiagram';
import { VoicemailGroupField, type TeamChoice } from './TargetPicker';
import { UpnAutocomplete } from './UpnAutocomplete';
import { WizardShell, type WizardStep } from './WizardShell';

/*
 * Call Flows (preview), docs/CALL-FLOWS-WIZARD.md step 2: screens 1 to 3 and Save. It asks about requirements, not settings, starting
 * from the phone number, with icon tiles in place of drop-downs. What it saves is exactly what the classic wizards save (the server's
 * saveVisualCallFlow), so everything downstream works unchanged. The canvas comes in step 3; until then a menu's options and a group's
 * people are filled in below the tile chosen. Engineers only while it is a preview (decided 10 Nov 2026).
 */

const useStyles = makeStyles({
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', ...shorthands.gap('8px') },
  compactTiles: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', ...shorthands.gap('6px') },
  bigTiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', ...shorthands.gap('10px') },
  tile: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    alignItems: 'start',
    columnGap: '10px',
    rowGap: '2px',
    textAlign: 'left',
    cursor: 'pointer',
    ...shorthands.padding('10px', '12px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, ...shorthands.borderColor(tokens.colorNeutralStroke1Hover) },
    ':focus-visible': { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: tokens.colorStrokeFocus2 },
  },
  tileOn: {
    ...shorthands.border('2px', 'solid', tokens.colorBrandStroke1),
    backgroundColor: tokens.colorBrandBackground2,
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover, ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  tileIcon: { fontSize: '24px', color: tokens.colorBrandForeground1, gridRow: 'span 2' },
  tileDesc: { color: tokens.colorNeutralForeground3 },
  numberTile: { fontVariantNumeric: 'tabular-nums', gridTemplateColumns: '1fr' },
  numbers: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', ...shorthands.gap('6px'), maxHeight: '220px', overflowY: 'auto', ...shorthands.padding('2px') },
  panel: {
    display: 'grid',
    ...shorthands.gap('10px'),
    ...shorthands.padding('12px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  row: { display: 'flex', ...shorthands.gap('6px'), alignItems: 'center' },
  rowTop: { display: 'flex', ...shorthands.gap('8px'), alignItems: 'start', flexWrap: 'wrap' },
  grow: { flexGrow: 1, minWidth: '160px' },
  keyBox: { width: '52px' },
  muted: { color: tokens.colorNeutralForeground3 },
  warn: { color: tokens.colorPaletteMarigoldForeground1 },
  list: { display: 'grid', ...shorthands.gap('4px'), ...shorthands.margin(0), paddingLeft: '18px' },
  summary: { whiteSpace: 'pre-wrap', fontFamily: 'inherit', ...shorthands.margin(0), display: 'grid', ...shorthands.gap('2px') },
  two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', ...shorthands.gap('10px') },
  canvasLayout: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', ...shorthands.gap('12px'), '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  sidePanel: {
    display: 'grid',
    alignContent: 'start',
    ...shorthands.gap('10px'),
    ...shorthands.padding('12px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
    maxHeight: '480px',
    overflowY: 'auto',
  },
});

/* ------------------------------------ tiles ------------------------------------ */

interface TileDef<K extends string> {
  key: K;
  icon: ReactElement;
  title: string;
  desc?: string;
}

/** A row of icon tiles, one chosen: a radio group a person can read at a glance instead of a drop-down. */
function Tiles<K extends string>({ label, tiles, value, onChange, big, compact }: { label: string; tiles: TileDef<K>[]; value: K | null; onChange: (k: K) => void; big?: boolean; compact?: boolean }) {
  const s = useStyles();
  return (
    <div role="radiogroup" aria-label={label} className={big ? s.bigTiles : compact ? s.compactTiles : s.tiles}>
      {tiles.map((t) => (
        <button
          key={t.key}
          type="button"
          role="radio"
          aria-checked={value === t.key}
          aria-label={t.desc ? `${t.title}: ${t.desc}` : t.title}
          className={mergeClasses(s.tile, value === t.key && s.tileOn)}
          onClick={() => onChange(t.key)}
        >
          <span className={s.tileIcon} aria-hidden>
            {t.icon}
          </span>
          <Text weight="semibold">{t.title}</Text>
          {t.desc && !compact ? (
            <Text size={200} className={s.tileDesc}>
              {t.desc}
            </Text>
          ) : (
            <span />
          )}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- what happens --------------------------------- */

type PathKind = 'menu' | 'group' | 'person' | 'shared_voicemail' | 'forward' | 'hangup';
const PATH_TILES: TileDef<PathKind>[] = [
  { key: 'menu', icon: <DialpadRegular />, title: 'Play a menu', desc: '"Press 1 for…"' },
  { key: 'group', icon: <PeopleTeamRegular />, title: 'Ring a group of people', desc: 'They share the calls' },
  { key: 'person', icon: <PersonRegular />, title: 'Ring one person' },
  { key: 'shared_voicemail', icon: <VoicemailRegular />, title: 'Go to voicemail', desc: 'A shared voicemail' },
  { key: 'forward', icon: <CallForwardRegular />, title: 'Forward to another number' },
  { key: 'hangup', icon: <CallEndRegular />, title: 'Play a message and hang up' },
];

type OptionKind = 'group' | 'person' | 'shared_voicemail' | 'forward' | 'link' | 'announcement';
const OPTION_TILES: TileDef<OptionKind>[] = [
  { key: 'group', icon: <PeopleTeamRegular />, title: 'Ring a group' },
  { key: 'person', icon: <PersonRegular />, title: 'Ring one person' },
  { key: 'shared_voicemail', icon: <VoicemailRegular />, title: 'Voicemail' },
  { key: 'forward', icon: <CallForwardRegular />, title: 'Forward' },
  { key: 'link', icon: <FlowRegular />, title: 'Another call flow' },
  { key: 'announcement', icon: <MegaphoneRegular />, title: 'Play a message' },
];

const RINGING: { key: VisualRinging; label: string }[] = [
  { key: 'all', label: 'Everyone at once' },
  { key: 'in_order', label: 'One after another' },
  { key: 'longest_idle', label: 'Whoever’s been free longest' },
  { key: 'take_turns', label: 'Taking turns' },
];

type EndKind = 'hangup' | 'shared_voicemail' | 'forward';

let localIds = 0;
const newLocalId = () => `local-${++localIds}`;

function stepFor(kind: PathKind | OptionKind, languageId: string): VisualStep | VisualOptionStep | { kind: 'menu'; options: VisualMenuOption[] } {
  switch (kind) {
    case 'menu':
      return { kind: 'menu', options: [] };
    case 'group':
      return newVisualGroup(newLocalId(), '', languageId);
    case 'person':
      return { kind: 'person', who: '' };
    case 'shared_voicemail':
      return { kind: 'shared_voicemail', group: '' };
    case 'forward':
      return { kind: 'forward', number: '' };
    case 'hangup':
      return { kind: 'hangup' };
    case 'link':
      return { kind: 'link', name: '' };
    case 'announcement':
      return { kind: 'announcement', text: '' };
  }
}

const voicemailTarget = (s: { group: string; groupId?: string; newGroup?: boolean }): WizardTarget => ({ kind: 'voicemail', label: s.group, ...(s.groupId ? { groupId: s.groupId } : {}), ...(s.newGroup ? { newGroup: true } : {}) });
const fromVoicemailTarget = (t: WizardTarget) => ({ kind: 'shared_voicemail' as const, group: t.label ?? '', ...(t.groupId ? { groupId: t.groupId } : {}), ...(t.newGroup ? { newGroup: true } : {}) });

interface Ctx {
  tenantId: string;
  siteId: string;
  teamChoices: TeamChoice[];
}

/** The details of one step: who, which group, which number. A group gets its own small form. */
function StepDetails({ step, onChange, ctx }: { step: VisualStep | VisualOptionStep; onChange: (s: VisualStep | VisualOptionStep) => void; ctx: Ctx }) {
  const s = useStyles();
  switch (step.kind) {
    case 'group':
      return <GroupDetails group={step} onChange={onChange} ctx={ctx} />;
    case 'person':
      return (
        <Field label="Who should the call ring?" required>
          <UpnAutocomplete tenantId={ctx.tenantId} siteId={ctx.siteId} value={step.who} onChange={(who) => onChange({ kind: 'person', who })} placeholder="jane.doe@contoso.com" />
        </Field>
      );
    case 'shared_voicemail':
      return <VoicemailGroupField tenantId={ctx.tenantId} value={voicemailTarget(step)} onChange={(t) => onChange(fromVoicemailTarget(t))} />;
    case 'forward':
      return (
        <Field label="Which number should calls be forwarded to?" required>
          <Input value={step.number} placeholder="+44 20 7946 0000" onChange={(_, d) => onChange({ kind: 'forward', number: d.value })} />
        </Field>
      );
    case 'link':
      return (
        <Field label="Which call flow on this site?" required hint={ctx.teamChoices.length ? undefined : 'There are no other call flows on this site yet.'}>
          <Dropdown
            value={step.name}
            selectedOptions={step.flowId ? [step.flowId] : step.name ? [step.name] : []}
            placeholder="Choose a call flow"
            onOptionSelect={(_, d) => {
              const picked = ctx.teamChoices.find((c) => c.value === d.optionValue);
              if (picked) onChange({ kind: 'link', name: picked.label, ...(picked.flowId ? { flowId: picked.flowId } : {}) });
            }}
          >
            {ctx.teamChoices.map((c) => (
              <Option key={c.value} value={c.value} text={c.label}>
                {c.label}
                {c.flowId ? ' (planned)' : ''}
              </Option>
            ))}
          </Dropdown>
        </Field>
      );
    case 'announcement':
      return (
        <Field label="What should callers hear? Then the menu plays again." required>
          <Textarea value={step.text} resize="vertical" placeholder="We're open Monday to Friday, nine till five." onChange={(_, d) => onChange({ kind: 'announcement', text: d.value })} />
        </Field>
      );
    case 'operator':
      return <Text className={s.muted}>The operator</Text>;
    case 'hangup':
      return null;
  }
}

function GroupDetails({ group, onChange, ctx }: { group: VisualGroup; onChange: (g: VisualGroup) => void; ctx: Ctx }) {
  const s = useStyles();
  const set = (patch: Partial<VisualGroup>) => onChange({ ...group, ...patch });
  const people = group.people.length ? group.people : [''];
  const end = group.ifNoAnswer;
  const endKind: EndKind = end.kind === 'shared_voicemail' ? 'shared_voicemail' : end.kind === 'forward' ? 'forward' : 'hangup';
  return (
    <div className={s.panel}>
      <Field label="What's the group called?" required>
        <Input value={group.name} placeholder="Sales" onChange={(_, d) => set({ name: d.value })} />
      </Field>
      <Field label="Who's in it?" required>
        <div className={s.list}>
          {people.map((p, i) => (
            <div key={i} className={s.row}>
              <UpnAutocomplete
                tenantId={ctx.tenantId}
                siteId={ctx.siteId}
                value={p}
                className={s.grow}
                placeholder="jane.doe@contoso.com"
                onChange={(v) => set({ people: people.map((x, j) => (j === i ? v : x)) })}
              />
              <Button icon={<DeleteRegular />} appearance="subtle" aria-label={`Remove ${p || 'this person'}`} disabled={people.length === 1 && !p} onClick={() => set({ people: people.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </div>
      </Field>
      <div>
        <Button size="small" icon={<AddRegular />} disabled={people.length >= 50} onClick={() => set({ people: [...people, ''] })}>
          Add person
        </Button>
      </div>
      <Field label="How should their phones ring?">
        <Tiles compact label="How their phones ring" tiles={RINGING.map((r) => ({ key: r.key, icon: <PeopleTeamRegular />, title: r.label }))} value={group.ringing} onChange={(ringing) => set({ ringing })} />
      </Field>
      <Field label="If nobody answers">
        <Tiles<EndKind>
          compact
          label="If nobody answers"
          tiles={[
            { key: 'hangup', icon: <CallEndRegular />, title: 'Hang up' },
            { key: 'shared_voicemail', icon: <VoicemailRegular />, title: 'Voicemail' },
            { key: 'forward', icon: <CallForwardRegular />, title: 'Forward' },
          ]}
          value={endKind}
          onChange={(k) => set({ ifNoAnswer: k === 'hangup' ? { kind: 'hangup' } : k === 'shared_voicemail' ? { kind: 'shared_voicemail', group: '' } : { kind: 'forward', to: '' } })}
        />
      </Field>
      {end.kind === 'shared_voicemail' && (
        <Field label="Which group's voicemail?" required>
          <Input value={end.group} placeholder="Sales voicemail" onChange={(_, d) => set({ ifNoAnswer: { kind: 'shared_voicemail', group: d.value } as VisualGroupEnd })} />
        </Field>
      )}
      {end.kind === 'forward' && (
        <Field label="Forward to a person or a number" required>
          <Input value={end.to} placeholder="+44 20 7946 0000" onChange={(_, d) => set({ ifNoAnswer: { kind: 'forward', to: d.value } })} />
        </Field>
      )}
      <Text size={200} className={s.muted}>
        Each phone rings for {group.ringSeconds} seconds; a caller waits up to {Math.round(group.maxWaitSeconds / 60)} minutes, and more than {group.maxWaiting} waiting are turned away.
      </Text>
    </div>
  );
}

const MENU_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
type PathKey = 'business' | 'after';

/** The six tiles for what happens: on screen 3 and after hours, and in a path's panel on the canvas. */
function PathTiles({ label, path, onChange, languageId, groupName, compact }: { label: string; path: VisualPath | null; onChange: (p: VisualPath) => void; languageId: string; groupName?: string; compact?: boolean }) {
  const kind = (path?.then.kind ?? null) as PathKind | null;
  const start = (k: PathKind): VisualPath['then'] => {
    const step = stepFor(k, languageId) as VisualPath['then'];
    return step.kind === 'group' && groupName ? { ...step, name: groupName } : step;
  };
  return <Tiles<PathKind> label={label} compact={compact} tiles={PATH_TILES} value={kind} onChange={(k) => k !== kind && onChange({ ...(path?.greeting ? { greeting: path.greeting } : {}), then: start(k) })} />;
}

/* ------------------------------------ the canvas's panels ------------------------------------ */

function PanelHeading({ title, sub }: { title: string; sub?: string }) {
  const s = useStyles();
  return (
    <div>
      <Text weight="semibold" size={400} block>
        {title}
      </Text>
      {sub && (
        <Text size={200} className={s.muted}>
          {sub}
        </Text>
      )}
    </div>
  );
}

/** The front door: the flow's name and number, and whether callers can speak their choice. */
function FrontPanel({ name, onName, number, hours, voiceInputs, onVoiceInputs, speech }: { name: string; onName: (v: string) => void; number: string | null; hours: string; voiceInputs: boolean; onVoiceInputs: (v: boolean) => void; speech: boolean }) {
  return (
    <>
      <PanelHeading title="The phone number" sub="A phone menu (auto attendant) answers it." />
      <Field label="Name" required>
        <Input value={name} placeholder="Main Line" onChange={(_, d) => onName(d.value)} />
      </Field>
      <Text>{number ?? 'No number chosen.'}</Text>
      <Text>{hours}</Text>
      <Switch
        checked={voiceInputs && speech}
        disabled={!speech}
        onChange={(_, d) => onVoiceInputs(d.checked)}
        label={speech ? 'Callers can say their choice as well as pressing a key' : 'Teams can’t recognise speech in this language, so callers press keys'}
      />
    </>
  );
}

/** A path (business hours, after hours, or every call): what happens, the greeting, and a menu's options. */
function PathPanel({
  title,
  path,
  onChange,
  languageId,
  groupName,
  onOpenOption,
  onAddOption,
}: {
  title: string;
  path: VisualPath | null;
  onChange: (p: VisualPath) => void;
  languageId: string;
  groupName?: string;
  onOpenOption: (i: number) => void;
  onAddOption: () => void;
}) {
  const s = useStyles();
  const t = path?.then;
  return (
    <>
      <PanelHeading title={title} sub="What should happen?" />
      <PathTiles compact label={`What happens: ${title}`} path={path} onChange={onChange} languageId={languageId} groupName={groupName} />
      {path && t?.kind === 'hangup' && (
        <Field label="What callers hear before the call ends" required>
          <Textarea value={path.greeting ?? ''} resize="vertical" placeholder="Thank you for calling. We're closed today." onChange={(_, d) => onChange({ ...path, greeting: d.value })} />
        </Field>
      )}
      {path && t && t.kind !== 'hangup' && (
        <Field label={t.kind === 'menu' ? 'Greeting (optional)' : 'Greeting played first (optional)'}>
          <Textarea value={path.greeting ?? ''} resize="vertical" placeholder="Thank you for calling Contoso." onChange={(_, d) => onChange({ ...path, greeting: d.value })} />
        </Field>
      )}
      {path && t?.kind === 'menu' && (
        <>
          <Text weight="semibold">Menu options</Text>
          {t.options.length === 0 && <Text className={s.muted}>No options yet.</Text>}
          <ul className={s.list}>
            {t.options.map((o, i) => (
              <li key={i}>
                <Button appearance="transparent" size="small" onClick={() => onOpenOption(i)}>
                  Press {o.key}: {o.label.trim() || '(no name)'}
                </Button>
                <Text size={200} className={s.muted} block>
                  The call {visualStepWords(o.then)}
                </Text>
              </li>
            ))}
          </ul>
          <div>
            <Button size="small" icon={<AddRegular />} disabled={t.options.length >= MENU_KEYS.length} onClick={onAddOption}>
              Add an option
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/** One menu option: its button, its name, what a caller can say, and what it does. */
function OptionPanel({
  option,
  siblings,
  onChange,
  onRemove,
  ctx,
  languageId,
  voiceInputs,
}: {
  option: VisualMenuOption;
  siblings: VisualMenuOption[];
  onChange: (o: VisualMenuOption) => void;
  onRemove: () => void;
  ctx: Ctx;
  languageId: string;
  voiceInputs: boolean;
}) {
  const s = useStyles();
  const o = option;
  return (
    <>
      <PanelHeading title={`Press ${o.key}${o.label.trim() ? ` for ${o.label.trim()}` : ''}`} sub="A menu option" />
      <div className={s.rowTop}>
        <Field label="Button">
          <Dropdown className={s.keyBox} value={o.key} selectedOptions={[o.key]} onOptionSelect={(_, d) => onChange({ ...o, key: d.optionValue ?? o.key })}>
            {MENU_KEYS.filter((k) => k === o.key || !siblings.some((x) => x.key === k)).map((k) => (
              <Option key={k} value={k}>
                {k}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="For" required className={s.grow}>
          <Input value={o.label} placeholder="Sales" onChange={(_, d) => onChange({ ...o, label: d.value })} />
        </Field>
      </div>
      {voiceInputs && (
        <Field label="Or callers can say" hint="One word or a short phrase, for example “sales”.">
          <Input value={o.say ?? ''} placeholder={o.label.trim().toLowerCase() || 'sales'} onChange={(_, d) => onChange({ ...o, say: d.value || undefined })} />
        </Field>
      )}
      <Field label="What happens">
        <Tiles<OptionKind>
          compact
          label={`What happens when a caller presses ${o.key}`}
          tiles={OPTION_TILES}
          value={o.then.kind === 'operator' ? null : (o.then.kind as OptionKind)}
          onChange={(k) => k !== o.then.kind && onChange({ ...o, then: stepFor(k, languageId) as VisualOptionStep })}
        />
      </Field>
      <StepDetails step={o.then} onChange={(then) => onChange({ ...o, then: then as VisualOptionStep })} ctx={ctx} />
      <div>
        <Button icon={<DeleteRegular />} appearance="subtle" onClick={onRemove}>
          Remove this option
        </Button>
      </div>
    </>
  );
}

const STEP_TITLES: Record<string, string> = {
  group: 'A group of people',
  person: 'One person',
  shared_voicemail: 'Voicemail',
  forward: 'Forward to another number',
  link: 'Another call flow',
  announcement: 'A message',
  operator: 'The operator',
};

/** A path's one step (not a menu): its details, with a way back to choosing something else. */
function StepPanel({ step, onChange, ctx, onChangeKind }: { step: VisualStep; onChange: (s: VisualStep) => void; ctx: Ctx; onChangeKind: () => void }) {
  return (
    <>
      <PanelHeading title={STEP_TITLES[step.kind] ?? 'What happens'} />
      <StepDetails step={step} onChange={(v) => onChange(v as VisualStep)} ctx={ctx} />
      <div>
        <Button size="small" appearance="subtle" onClick={onChangeKind}>
          Choose something else
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------ hours ------------------------------------ */

type HoursKind = 'always' | 'standard' | 'eight_six' | 'custom';
const weekdays = (start: string, end: string): WizardWeeklyHours => ({
  monday: [{ start, end }],
  tuesday: [{ start, end }],
  wednesday: [{ start, end }],
  thursday: [{ start, end }],
  friday: [{ start, end }],
  saturday: [],
  sunday: [],
});
const EIGHT_SIX = weekdays('08:00', '18:00');
const isEightSix = (w: WizardWeeklyHours) => JSON.stringify(w) === JSON.stringify(EIGHT_SIX);

/* ------------------------------------ wizard ------------------------------------ */

export interface CallFlowsPreviewNumber {
  id: string;
  e164: string;
}

/** A voice app already on the site, with its numbers: a number in use offers to open its call flow instead. */
export interface CallFlowsPreviewVoiceApp {
  id: string;
  name: string;
  numbers: string[];
}

const digits = (v: string) => v.replace(/\D/g, '');

export function CallFlowsPreviewWizard({
  open,
  onOpenChange,
  base,
  tenantId,
  siteId,
  site,
  spareNumbers,
  voiceApps,
  teamChoices,
  onOpenExisting,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  tenantId: string;
  siteId: string;
  site: { country?: string | null; address?: string | null };
  spareNumbers: CallFlowsPreviewNumber[];
  voiceApps: CallFlowsPreviewVoiceApp[];
  teamChoices: TeamChoice[];
  /** opens a voice app's call flow (decided 10 Nov 2026: a number already in use offers that instead of a new flow) */
  onOpenExisting: (voiceAppId: string) => void;
  onCreated: (name: string) => void;
}) {
  const s = useStyles();
  const defaults = useMemo(() => callFlowDefaultsForSite(site), [site]);
  const [name, setName] = useState('');
  const [numberId, setNumberId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hours, setHours] = useState<HoursKind | null>(null);
  const [weekly, setWeekly] = useState<WizardWeeklyHours>(weekdays('09:00', '17:00'));
  const [business, setBusiness] = useState<VisualPath | null>(null);
  const [afterHours, setAfterHours] = useState<VisualPath | null>(null);
  const [straight, setStraight] = useState(false);
  const [languageId, setLanguageId] = useState(defaults.languageId);
  const [timeZoneId, setTimeZoneId] = useState(defaults.timeZoneId);
  const [error, setError] = useState<string | null>(null);
  const [voiceInputs, setVoiceInputs] = useState(false);
  /** the box on the canvas whose panel is open */
  const [selected, setSelected] = useState<string | null>(null);

  const ctx: Ctx = { tenantId, siteId, teamChoices };
  const number = spareNumbers.find((n) => n.id === numberId) ?? null;
  const always = hours === 'always';

  const speech = !!AA_SUPPORTED_LANGUAGES.find((l) => l.code === languageId)?.speechInput;
  // memoised, so the canvas is only drawn again when the flow itself changes
  const flow: VisualCallFlow | null = useMemo(
    () =>
      business && hours
        ? {
            name: name.trim(),
            languageId,
            timeZoneId,
            ...(voiceInputs && speech ? { voiceInputs: true } : {}),
            hours: hours === 'always' ? { type: 'always' } : hours === 'standard' ? { type: 'standard' } : { type: 'custom', weekly: hours === 'eight_six' ? EIGHT_SIX : weekly },
            business: { ...business, then: withLanguage(business.then, languageId) },
            ...(hours !== 'always' && afterHours ? { afterHours: { ...afterHours, then: withLanguage(afterHours.then, languageId) } } : {}),
          }
        : null,
    [business, hours, name, languageId, timeZoneId, voiceInputs, speech, weekly, afterHours],
  );
  // straight to the group: the number answers the group's call queue, which can't play a greeting first
  const canGoStraight = !!flow && !!onlyRingsAGroup({ ...flow, business: { then: flow.business.then } });
  const goStraight = straight && canGoStraight;
  const sent: VisualCallFlow | null = useMemo(() => (flow && goStraight ? { ...flow, business: { then: flow.business.then } } : flow), [flow, goStraight]);
  const canvas = useMemo(() => (sent ? visualFlowCanvas(sent, { number: number?.e164 ?? null, straightToQueue: goStraight }) : null), [sent, number, goStraight]);
  const problem = sent ? visualCallFlowProblem(sent) : null;

  // the canvas's panels: what the selected box is, and how to change it
  const pathOf = (k: PathKey) => (k === 'business' ? business : afterHours);
  const setPath = (k: PathKey, p: VisualPath) => (k === 'business' ? setBusiness(p) : setAfterHours(p));
  const optionNodeId = (k: PathKey, i: number, o: VisualMenuOption) => (o.then.kind === 'group' ? `group:${o.then.id}` : `${k}:o${i}`);
  const addOption = (k: PathKey) => {
    const p = pathOf(k);
    if (!p || p.then.kind !== 'menu') return;
    const menu = p.then;
    const key = MENU_KEYS.find((x) => !menu.options.some((o) => o.key === x));
    if (!key) return;
    const o: VisualMenuOption = { key, label: '', then: newVisualGroup(newLocalId(), '', languageId) };
    setPath(k, { ...p, then: { ...menu, options: [...menu.options, o] } });
    setSelected(optionNodeId(k, menu.options.length, o));
  };
  const onPlus = (id: string) => {
    const plus = canvas?.plus[id];
    const address = canvas?.addressOf[id];
    if (plus?.kind === 'add_option' && (address === 'business' || address === 'after')) addOption(address);
    else setSelected(id);
  };
  const address = selected ? canvas?.addressOf[selected] : undefined;
  const panel = ((): ReactNode => {
    if (!address) return <Text className={s.muted}>Click a box on the left to see what it does and change it.</Text>;
    if (address === 'front')
      return (
        <FrontPanel
          name={name}
          onName={setName}
          number={number?.e164 ?? null}
          hours={visualHoursWords(sent!.hours)}
          voiceInputs={voiceInputs}
          onVoiceInputs={setVoiceInputs}
          speech={speech}
        />
      );
    const [k, rest] = address.split('.') as [PathKey, string | undefined];
    const p = pathOf(k);
    const title = always ? 'When someone calls' : k === 'business' ? 'During business hours' : 'After hours';
    const pathPanel = (
      <PathPanel
        title={title}
        path={p}
        onChange={(np) => setPath(k, np)}
        languageId={languageId}
        groupName={k === 'business' ? name.trim() : undefined}
        onOpenOption={(i) => p?.then.kind === 'menu' && setSelected(optionNodeId(k, i, p.then.options[i]!))}
        onAddOption={() => addOption(k)}
      />
    );
    if (!rest || !p) return pathPanel;
    const t = p.then;
    if (rest === 'then') {
      if (t.kind === 'menu' || t.kind === 'hangup') return pathPanel;
      return <StepPanel step={t} onChange={(v) => setPath(k, { ...p, then: v })} ctx={ctx} onChangeKind={() => setSelected(k)} />;
    }
    const i = Number(rest.slice(1));
    if (t.kind !== 'menu' || !t.options[i]) return pathPanel;
    return (
      <OptionPanel
        key={`${k}.${i}`}
        option={t.options[i]!}
        siblings={t.options}
        voiceInputs={!!sent?.voiceInputs}
        ctx={ctx}
        languageId={languageId}
        onChange={(o) => {
          setPath(k, { ...p, then: { ...t, options: t.options.map((x, j) => (j === i ? o : x)) } });
          // a different kind of step is a different box: keep its panel open
          if (o.then.kind !== t.options[i]!.then.kind || (o.then.kind === 'group' && t.options[i]!.then.kind === 'group' && o.then.id !== (t.options[i]!.then as VisualGroup).id)) setSelected(optionNodeId(k, i, o));
        }}
        onRemove={() => {
          setPath(k, { ...p, then: { ...t, options: t.options.filter((_, j) => j !== i) } });
          setSelected(k);
        }}
      />
    );
  })();

  const reset = () => {
    setName('');
    setNumberId(null);
    setSearch('');
    setHours(null);
    setWeekly(weekdays('09:00', '17:00'));
    setBusiness(null);
    setAfterHours(null);
    setStraight(false);
    setLanguageId(defaults.languageId);
    setTimeZoneId(defaults.timeZoneId);
    setVoiceInputs(false);
    setSelected(null);
    setError(null);
  };

  const save = useMutation({
    mutationFn: () => api<{ voiceAppId: string; flowId: string; queues: number }>(`${base}/call-flows`, { method: 'POST', body: JSON.stringify({ site_id: siteId, phone_number_id: numberId, flow: sent, ...(goStraight ? { straight_to_queue: true } : {}) }) }),
    onSuccess: () => {
      const made = name.trim();
      onOpenChange(false);
      reset();
      onCreated(made);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  // screen 1: the number. Typing a number shows the spare ones that match, or the call flow that already answers it.
  // a national "0141 …" finds "+44141 …": the leading 0 isn't part of the international number
  const q = digits(search).replace(/^0+/, '');
  const matches = q ? spareNumbers.filter((n) => digits(n.e164).includes(q)) : spareNumbers;
  const inUse = q.length >= 6 ? voiceApps.find((a) => a.numbers.some((n) => digits(n).includes(q))) : undefined;
  const shown = matches.slice(0, 60);

  const steps: WizardStep[] = [
    {
      key: 'number',
      title: 'The number',
      validate: () => (!numberId ? 'Choose the number people will call.' : !name.trim() ? 'Give the call flow a name, for example "Main Line".' : null),
      content: (
        <>
          <Text weight="semibold" size={400}>
            What number will people call?
          </Text>
          <Input contentBefore={<SearchRegular />} value={search} placeholder="Search this site's spare numbers" aria-label="Search this site's spare numbers" onChange={(_, d) => setSearch(d.value)} />
          {inUse && (
            <div className={s.panel}>
              <Text>
                A number like that already answers <strong>{inUse.name}</strong>.
              </Text>
              <div>
                <Button
                  size="small"
                  onClick={() => {
                    onOpenChange(false);
                    reset();
                    onOpenExisting(inUse.id);
                  }}
                >
                  Open that call flow
                </Button>
              </div>
            </div>
          )}
          {spareNumbers.length === 0 ? (
            <Text className={s.warn}>This site has no spare numbers. Add a number range on the Numbers tab first.</Text>
          ) : matches.length === 0 ? (
            <Text className={s.muted}>None of this site's spare numbers match "{search}".</Text>
          ) : (
            <div role="radiogroup" aria-label="Spare numbers" className={s.numbers}>
              {shown.map((n) => (
                <button key={n.id} type="button" role="radio" aria-checked={numberId === n.id} aria-label={n.e164} className={mergeClasses(s.tile, s.numberTile, numberId === n.id && s.tileOn)} onClick={() => setNumberId(n.id)}>
                  <Text weight={numberId === n.id ? 'semibold' : 'regular'}>{n.e164}</Text>
                </button>
              ))}
            </div>
          )}
          {matches.length > shown.length && (
            <Text size={200} className={s.muted}>
              Showing {shown.length} of {matches.length}. Type more of the number to narrow it down.
            </Text>
          )}
          <Field label="What should we call it?" required hint="Callers don't hear this. It's the name in Teams and in the handover pack.">
            <Input value={name} placeholder="Main Line" onChange={(_, d) => setName(d.value)} />
          </Field>
        </>
      ),
    },
    {
      key: 'hours',
      title: 'Opening hours',
      validate: () => (!hours ? 'Choose whether it works the same way all the time.' : hours === 'custom' && !Object.values(weekly).some((d) => d.length) ? 'Choose at least one day the business is open.' : null),
      content: (
        <>
          <Text weight="semibold" size={400}>
            Does it work the same way all the time?
          </Text>
          <Tiles<'always' | 'hours'>
            big
            label="Does it work the same way all the time?"
            tiles={[
              { key: 'always', icon: <ClockRegular />, title: 'Same 24x7', desc: 'Calls are handled the same way day and night.' },
              { key: 'hours', icon: <CalendarClockRegular />, title: 'Different during business hours', desc: 'Something else happens when you are closed.' },
            ]}
            value={hours === null ? null : hours === 'always' ? 'always' : 'hours'}
            onChange={(k) => setHours(k === 'always' ? 'always' : hours && hours !== 'always' ? hours : 'standard')}
          />
          {hours && hours !== 'always' && (
            <>
              <Text weight="semibold">When are you open?</Text>
              <Tiles<Exclude<HoursKind, 'always'>>
                label="When are you open?"
                tiles={[
                  { key: 'standard', icon: <WeatherSunnyRegular />, title: 'Mon to Fri, 9 to 5' },
                  { key: 'eight_six', icon: <WeatherSunnyRegular />, title: 'Mon to Fri, 8 to 6' },
                  { key: 'custom', icon: <CalendarClockRegular />, title: 'Other hours' },
                ]}
                value={hours}
                onChange={(k) => {
                  if (k === 'custom' && hours !== 'custom') setWeekly(hours === 'eight_six' ? EIGHT_SIX : weekdays('09:00', '17:00'));
                  setHours(k);
                }}
              />
              {hours === 'custom' && <WeeklyHoursEditor value={weekly} onChange={(w) => (isEightSix(w) ? (setWeekly(w), setHours('eight_six')) : setWeekly(w))} />}
            </>
          )}
        </>
      ),
    },
    {
      key: 'business',
      title: always ? 'When someone calls' : 'During business hours',
      validate: () => (!business ? 'Choose what should happen.' : null),
      content: (
        <>
          <Text weight="semibold" size={400}>
            {always ? 'When someone calls, what should happen?' : 'When someone calls during business hours, what should happen?'}
          </Text>
          <PathTiles label="What should happen" path={business} groupName={name.trim()} onChange={setBusiness} languageId={languageId} />
          {always && business?.then.kind === 'group' && (
            <Switch checked={straight} onChange={(_, d) => setStraight(d.checked)} label="Send calls straight to the group, with no phone menu in front" />
          )}
          {business && <Text className={s.muted}>Next you'll see the call flow drawn out, and fill in the details there.</Text>}
        </>
      ),
    },
    ...(always
      ? []
      : [
          {
            key: 'after-hours',
            title: 'After hours',
            validate: () => (!afterHours ? 'Choose what should happen after hours.' : null),
            content: (
              <>
                <Text weight="semibold" size={400}>
                  When someone calls outside business hours, what should happen?
                </Text>
                <PathTiles label="What should happen after hours" path={afterHours} onChange={setAfterHours} languageId={languageId} />
              </>
            ),
          } satisfies WizardStep,
        ]),
    {
      key: 'canvas',
      title: 'Your call flow',
      validate: () => (sent ? visualCallFlowProblem(sent) : 'Something is missing. Go back and check each step.'),
      content: canvas ? (
        <>
          <div>
            <Text weight="semibold" size={400} block>
              Your call flow
            </Text>
            <Text className={s.muted}>Click a box to fill it in or change it. A + adds what can come next.</Text>
          </div>
          {problem && (
            <Text className={s.warn} role="status">
              Still to do: {problem}
            </Text>
          )}
          <div className={s.canvasLayout}>
            <CallFlowEditorCanvas graph={canvas.graph} editing={{ selectedId: selected, plus: canvas.plus, onSelect: setSelected, onPlus }} />
            <div className={s.sidePanel} aria-label="Details of the selected box">
              {panel}
            </div>
          </div>
        </>
      ) : (
        <Text>Something is missing. Go back and check each step.</Text>
      ),
    },
    {
      key: 'review',
      title: 'Review',
      validate: () => (sent ? visualCallFlowProblem(sent) : 'Something is missing. Go back and check each step.'),
      content: sent ? (
        <>
          <Text weight="semibold" size={400}>
            Check it over
          </Text>
          <div className={s.summary}>
            {visualFlowSummary(sent, number?.e164 ?? null).map((l, i) => (
              <Text key={i} block>
                {l}
              </Text>
            ))}
          </div>
          <Text weight="semibold">What Voxshift will create</Text>
          <ul className={s.list}>
            {visualFlowCreates(sent, { straightToQueue: goStraight, number: number?.e164 ?? null }).map((c, i) => (
              <li key={i}>
                <Text>
                  {c.plain}: <strong>{c.name}</strong> <span className={s.muted}>({c.teams})</span>
                </Text>
              </li>
            ))}
          </ul>
          <div className={s.two}>
            <Field label="Language for the automated voice">
              <Dropdown value={AA_SUPPORTED_LANGUAGES.find((l) => l.code === languageId)?.label ?? languageId} selectedOptions={[languageId]} onOptionSelect={(_, d) => d.optionValue && setLanguageId(d.optionValue)}>
                {AA_SUPPORTED_LANGUAGES.map((l) => (
                  <Option key={l.code} value={l.code}>
                    {l.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Time zone for the opening hours">
              <Dropdown value={AA_TIME_ZONES.find((z) => z.id === timeZoneId)?.label ?? timeZoneId} selectedOptions={[timeZoneId]} onOptionSelect={(_, d) => d.optionValue && setTimeZoneId(d.optionValue)}>
                {AA_TIME_ZONES.map((z) => (
                  <Option key={z.id} value={z.id}>
                    {z.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>
          <Text size={200} className={s.muted}>
            It's saved on the Call flows tab like any other, and opens in the classic wizards too. Import it to Design &amp; Build as usual.
          </Text>
        </>
      ) : (
        <Text>Something is missing. Go back and check each step.</Text>
      ),
    },
  ];

  return (
    <WizardShell
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setError(null);
      }}
      title="New call flow (preview)"
      wide
      steps={steps}
      onComplete={() => {
        setError(null);
        save.mutate();
      }}
      completing={save.isPending}
      completeLabel="Save"
      error={error}
    />
  );
}

/** Groups take the flow's language, so a change on the review screen reaches them too. */
function withLanguage<T extends VisualPath['then']>(t: T, languageId: string): T {
  if (t.kind === 'group') return { ...t, languageId };
  if (t.kind === 'menu') return { ...t, options: t.options.map((o) => (o.then.kind === 'group' ? { ...o, then: { ...o.then, languageId } } : o)) };
  return t;
}

/** The "Preview" badge beside the tile and on call flows it made. */
export function PreviewBadge() {
  return (
    <Badge appearance="tint" color="informative" size="small">
      Preview
    </Badge>
  );
}
