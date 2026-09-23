import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import { Button, Checkbox, Dropdown, Field, Input, Option, RadioGroup, Radio, Text } from '@fluentui/react-components';
import {
  AA_SUPPORTED_LANGUAGES,
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_NO_AGENT_APPLY_TO,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
  type CallQueueWizardAnswers,
} from '@tvmf/shared';
import { api, ApiError } from '../api';
import { type Choice } from './records';
import { UpnAutocomplete } from './UpnAutocomplete';
import { WizardShell, type WizardStep } from './WizardShell';

const LANGUAGE_CHOICES: Choice[] = AA_SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));

const ROUTING_LABELS: Record<(typeof CALL_QUEUE_ROUTING_METHODS)[number], string> = {
  Attendant: 'Ring everyone at once - first to answer gets it',
  Serial: 'Ring one person at a time, in order',
  RoundRobin: 'Spread calls evenly across the team (recommended)',
  LongestIdle: "Give the call to whoever's been free longest (recommended)",
};

// buildCallQueueWritable's overflow/timeout/no_agent_action fields (dto.ts)
// are typed as plain `action?: string`, not a literal union (their zod
// helper widens the parameter type deliberately) - CallQueueWizardAnswers
// mirrors that, so these lookup tables index by plain string too.
const OVERFLOW_LABELS: Record<string, string> = {
  DisconnectWithBusy: 'Play a busy signal and hang up',
  Forward: 'Send the call somewhere else',
  Voicemail: 'Send to voicemail',
  SharedVoicemail: 'Send to shared voicemail',
};
const TIMEOUT_LABELS: Record<string, string> = {
  Disconnect: 'Hang up',
  Forward: 'Send the call somewhere else',
  Voicemail: 'Send to voicemail',
  SharedVoicemail: 'Send to shared voicemail',
};
const NO_AGENT_LABELS: Record<string, string> = {
  Queue: 'Keep them waiting in the queue',
  Disconnect: 'Hang up',
  Forward: 'Send the call somewhere else',
  Voicemail: 'Send to voicemail',
  SharedVoicemail: 'Send to shared voicemail',
};
const APPLY_TO_LABELS: Record<(typeof CALL_QUEUE_NO_AGENT_APPLY_TO)[number], string> = {
  AllCalls: 'Everyone - calls already waiting too',
  NewCalls: 'Only new calls from now on',
};

/**
 * One overflow/timeout/no-agent exception answer - an action dropdown, plus
 * a "send it to" field only when the action needs one. Typed loosely over
 * plain `string` rather than parameterized on each call's own literal
 * union - the three call sites below each carry a differently-narrowed
 * `CallQueueWizardAnswers` sub-type, and threading that through a generic
 * component's inferred callback parameter fought TypeScript's inference
 * more than it was worth; each call site casts back to its own narrow type.
 */
function ActionAnswerEditor({
  actions,
  labels,
  value,
  onChange,
  tenantId,
}: {
  actions: readonly string[];
  labels: Record<string, string>;
  value: { action: string; forwardTo?: string };
  onChange: (v: { action: string; forwardTo?: string }) => void;
  tenantId: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <Dropdown
        value={labels[value.action]}
        selectedOptions={[value.action]}
        onOptionSelect={(_, d) => onChange({ ...value, action: d.optionValue ?? value.action })}
        style={{ minWidth: 260 }}
      >
        {actions.map((a) => (
          <Option key={a} value={a}>
            {labels[a]}
          </Option>
        ))}
      </Dropdown>
      {value.action === 'Forward' && (
        <Field label="Send it to (name, department, or number)">
          <UpnAutocomplete
            tenantId={tenantId}
            value={value.forwardTo ?? ''}
            onChange={(v) => onChange({ ...value, forwardTo: v })}
            style={{ minWidth: 220 }}
          />
        </Field>
      )}
    </div>
  );
}

const DEFAULT_ANSWERS: CallQueueWizardAnswers = {
  languageId: 'en-US',
  agents: [],
  routingMethod: 'RoundRobin',
  presenceBasedRouting: true,
  agentAlertTime: 20,
  overflowThreshold: 50,
  overflow: { action: 'DisconnectWithBusy' },
  timeoutThreshold: 1800,
  timeout: { action: 'Disconnect' },
  noAgents: { action: 'Queue' },
  noAgentsApplyTo: 'AllCalls',
};

/** An existing wizard-captured Call flows row, reopened for editing - see SiteWorkspace.tsx's onEditRow. */
export interface CallQueueWizardEditing {
  id: string;
  name: string;
  answers: CallQueueWizardAnswers;
  resourceAccountId: string | null;
}

export function CallQueueWizard({
  open,
  onOpenChange,
  base,
  tenantId,
  siteId,
  resourceAccountChoices,
  onCreated,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  tenantId: string;
  siteId: string;
  resourceAccountChoices: Choice[];
  onCreated: () => void;
  /** Editing an already-saved wizard capture instead of creating a new one - PATCHes the existing flow row and shows "Save changes" instead of "Create". Render with `key={editing.id}` so each row gets its own fresh state. */
  editing?: CallQueueWizardEditing;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [answers, setAnswers] = useState<CallQueueWizardAnswers>(editing?.answers ?? DEFAULT_ANSWERS);
  const [resourceAccountId, setResourceAccountId] = useState(editing?.resourceAccountId ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        ...(editing ? {} : { site_id: siteId, kind: 'call_queue' }),
        name,
        description: `Captured via the Call Queue wizard - ${answers.agents.length} agent(s), ${ROUTING_LABELS[answers.routingMethod]}`,
        wizard_answers: answers,
        wizard_version: 1,
        resource_account_id: resourceAccountId || null,
      });
      return editing ? api(`${base}/flows/${editing.id}`, { method: 'PATCH', body }) : api(`${base}/flows`, { method: 'POST', body });
    },
    onSuccess: () => {
      onOpenChange(false);
      if (!editing) {
        setName('');
        setAnswers(DEFAULT_ANSWERS);
        setResourceAccountId('');
      }
      onCreated();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  const setAgent = (i: number, v: string) => setAnswers((a) => ({ ...a, agents: a.agents.map((x, idx) => (idx === i ? v : x)) }));

  const steps: WizardStep[] = [
    {
      key: 'basics',
      title: 'Basics',
      validate: () => (!name.trim() ? 'Give this call queue a name.' : null),
      content: (
        <>
          <Field label="What do you want to call this call queue?" required>
            <Input value={name} placeholder="Support Team" onChange={(_, d) => setName(d.value)} />
          </Field>
          <Field label="What language should the automated voice speak?">
            <Dropdown
              value={LANGUAGE_CHOICES.find((c) => c.value === answers.languageId)?.label ?? ''}
              selectedOptions={[answers.languageId]}
              onOptionSelect={(_, d) => setAnswers((a) => ({ ...a, languageId: d.optionValue ?? a.languageId }))}
            >
              {LANGUAGE_CHOICES.map((c) => (
                <Option key={c.value} value={c.value}>
                  {c.label}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </>
      ),
    },
    {
      key: 'agents',
      title: 'Who answers',
      content: (
        <>
          <Text block>Who should answer these calls? Add each person's name or email.</Text>
          <div style={{ display: 'grid', gap: 6 }}>
            {answers.agents.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 6 }}>
                <UpnAutocomplete tenantId={tenantId} value={a} onChange={(v) => setAgent(i, v)} placeholder="jane.doe@contoso.com" style={{ flex: 1 }} />
                <Button
                  icon={<DeleteRegular />}
                  appearance="subtle"
                  aria-label="Remove"
                  onClick={() => setAnswers((ans) => ({ ...ans, agents: ans.agents.filter((_, idx) => idx !== i) }))}
                />
              </div>
            ))}
            <Button
              size="small"
              icon={<AddRegular />}
              disabled={answers.agents.length >= 50}
              onClick={() => setAnswers((a) => ({ ...a, agents: [...a.agents, ''] }))}
            >
              Add person
            </Button>
          </div>
          <Field label="How should incoming calls be shared among them?">
            <Dropdown
              value={ROUTING_LABELS[answers.routingMethod]}
              selectedOptions={[answers.routingMethod]}
              onOptionSelect={(_, d) => setAnswers((a) => ({ ...a, routingMethod: (d.optionValue ?? a.routingMethod) as typeof a.routingMethod }))}
            >
              {CALL_QUEUE_ROUTING_METHODS.map((m) => (
                <Option key={m} value={m}>
                  {ROUTING_LABELS[m]}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Checkbox
            checked={answers.presenceBasedRouting}
            label="Only ring people who are free (not already on a call or set to do not disturb)"
            onChange={(_, d) => setAnswers((a) => ({ ...a, presenceBasedRouting: !!d.checked }))}
          />
          <Field label="How long should we try each person before moving on? (seconds)">
            <Input
              type="number"
              value={String(answers.agentAlertTime)}
              onChange={(_, d) => setAnswers((a) => ({ ...a, agentAlertTime: Number(d.value) || a.agentAlertTime }))}
              style={{ width: 120 }}
            />
          </Field>
        </>
      ),
    },
    {
      key: 'overflow',
      title: 'Too many calls waiting',
      content: (
        <>
          <Field label="How many calls should be allowed to wait at once?">
            <Input
              type="number"
              value={String(answers.overflowThreshold)}
              onChange={(_, d) => setAnswers((a) => ({ ...a, overflowThreshold: Number(d.value) || 0 }))}
              style={{ width: 120 }}
            />
          </Field>
          <Text block>When that limit is reached, what should happen to the extra calls?</Text>
          <ActionAnswerEditor
            actions={CALL_QUEUE_OVERFLOW_ACTIONS}
            labels={OVERFLOW_LABELS}
            value={answers.overflow}
            onChange={(v) => setAnswers((a) => ({ ...a, overflow: v as CallQueueWizardAnswers['overflow'] }))}
            tenantId={tenantId}
          />
        </>
      ),
    },
    {
      key: 'timeout',
      title: 'Waiting too long',
      content: (
        <>
          <Field label="How long should someone wait before we do something different? (seconds)">
            <Input
              type="number"
              value={String(answers.timeoutThreshold)}
              onChange={(_, d) => setAnswers((a) => ({ ...a, timeoutThreshold: Number(d.value) || 0 }))}
              style={{ width: 120 }}
            />
          </Field>
          <Text block>What should happen then?</Text>
          <ActionAnswerEditor
            actions={CALL_QUEUE_TIMEOUT_ACTIONS}
            labels={TIMEOUT_LABELS}
            value={answers.timeout}
            onChange={(v) => setAnswers((a) => ({ ...a, timeout: v as CallQueueWizardAnswers['timeout'] }))}
            tenantId={tenantId}
          />
        </>
      ),
    },
    {
      key: 'no-agents',
      title: 'Nobody available',
      content: (
        <>
          <Text block>What should happen if nobody's logged in or available to take calls?</Text>
          <ActionAnswerEditor
            actions={CALL_QUEUE_NO_AGENT_ACTIONS}
            labels={NO_AGENT_LABELS}
            value={answers.noAgents}
            onChange={(v) => setAnswers((a) => ({ ...a, noAgents: v as CallQueueWizardAnswers['noAgents'] }))}
            tenantId={tenantId}
          />
          <Field label="Should this apply to calls already waiting too, or just new calls?">
            <RadioGroup
              value={answers.noAgentsApplyTo}
              onChange={(_, d) => setAnswers((a) => ({ ...a, noAgentsApplyTo: d.value as typeof a.noAgentsApplyTo }))}
            >
              {CALL_QUEUE_NO_AGENT_APPLY_TO.map((v) => (
                <Radio key={v} value={v} label={APPLY_TO_LABELS[v]} />
              ))}
            </RadioGroup>
          </Field>
        </>
      ),
    },
    {
      key: 'review',
      title: 'Review',
      content: (
        <>
          <Text size={200} block>
            {answers.agents.filter(Boolean).length} agent(s) · {ROUTING_LABELS[answers.routingMethod]}
          </Text>
          <Text size={200} block>
            Too many calls waiting ({answers.overflowThreshold}+): {OVERFLOW_LABELS[answers.overflow.action]}
          </Text>
          <Text size={200} block>
            Waiting too long ({answers.timeoutThreshold}s+): {TIMEOUT_LABELS[answers.timeout.action]}
          </Text>
          <Text size={200} block>
            Nobody available: {NO_AGENT_LABELS[answers.noAgents.action]} ({APPLY_TO_LABELS[answers.noAgentsApplyTo]})
          </Text>
          <Text size={200} block style={{ marginTop: 8 }}>
            Note: Call queues don't have their own after-hours/holiday handling in Teams - put an Auto Attendant in front of
            this queue if you need that.
          </Text>
          <Field label="Which phone number/identity will answer this? (optional - can be set later)">
            <Dropdown
              value={resourceAccountChoices.find((c) => c.value === resourceAccountId)?.label ?? '— not yet known —'}
              selectedOptions={resourceAccountId ? [resourceAccountId] : []}
              onOptionSelect={(_, d) => setResourceAccountId(d.optionValue ?? '')}
            >
              <Option value="">— not yet known —</Option>
              {resourceAccountChoices.map((c) => (
                <Option key={c.value} value={c.value}>
                  {c.label}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </>
      ),
    },
  ];

  return (
    <WizardShell
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        // Reset on Cancel too, not just on a successful save - the "New"
        // instance stays mounted the whole time (WizardTiles just toggles
        // `open`), so leftover text/answers from an abandoned attempt would
        // otherwise still be there next time this tile is opened. Not
        // needed in edit mode - that instance is remounted fresh (key={editing.id})
        // every time a different row is opened for editing.
        if (!o && !editing) {
          setError(null);
          setName('');
          setAnswers(DEFAULT_ANSWERS);
          setResourceAccountId('');
        }
      }}
      title={editing ? `Edit "${editing.name}"` : 'New Call Queue'}
      steps={steps}
      completing={save.isPending}
      completeLabel={editing ? 'Save changes' : 'Create'}
      error={error}
      onComplete={() => {
        setError(null);
        save.mutate();
      }}
    />
  );
}
