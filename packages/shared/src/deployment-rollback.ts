import { isGlobalPolicyName, renderStatement, type VarRef } from './deployment';
import { GRANT_CMDLET_POLICY, lineUriToNumber, type IdentityBeforeState } from './deployment-verify';

/* ========================================================================
 * Rollback script for a live deployment run - generated from the run's own
 * deployment_changes (result 'applied', with `before`), offered as a
 * download, and never run by Voxshift. See docs/DEPLOYMENT.md "Rolling back".
 * ======================================================================== */

/** The deployment_changes columns the generator reads. */
export interface RollbackChangeInput {
  seq: number;
  object_type: string;
  cmdlet: string;
  parameters: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  result: 'applied' | 'skipped' | 'failed' | 'whatif';
}

export interface RollbackStep {
  /** the deployment_changes.seq this undoes */
  seq: number;
  /** what it puts back, for the comment above the command */
  note: string;
  command: string;
}

export interface RollbackNotReversible {
  seq: number;
  cmdlet: string;
  identity: string;
  reason: string;
}

export interface RollbackPlan {
  /** in the order to run them - newest change first */
  steps: RollbackStep[];
  notReversible: RollbackNotReversible[];
  /** New-CsOnlineApplicationInstance lines handed to the engineer in the exported script - created outside Voxshift, if at all */
  externallyCreated: { seq: number; identity: string }[];
  /** commands that failed, so changed nothing and need no undo */
  failedCount: number;
}

const NULL_REF: VarRef = { $var: 'null' };
const digits = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '').slice(-10);
const identityOf = (p: Record<string, unknown>) => String(p.Identity ?? p.UserPrincipalName ?? p.Name ?? '');

/** Why a non-identity change can't be undone by script. */
function objectReason(cmdlet: string): string {
  if (/^New-/.test(cmdlet)) return 'created by this run - delete it in Teams admin center if it is not wanted';
  if (/^Set-/.test(cmdlet)) return 'its previous configuration is not recorded - restore it by hand';
  return 'not reversible by script';
}

/**
 * Work out the reverse of each applied change, newest first. Pure - every
 * input comes from deployment_changes. A change whose `before` wasn't
 * captured (runs before this existed, a person Discovery had never seen, or
 * a setting Discovery doesn't read) is listed as not reversible rather than
 * guessed at.
 */
export function planRollback(changes: RollbackChangeInput[]): RollbackPlan {
  const plan: RollbackPlan = { steps: [], notReversible: [], externallyCreated: [], failedCount: 0 };
  const ordered = [...changes].sort((a, b) => b.seq - a.seq);

  for (const c of ordered) {
    const p = c.parameters ?? {};
    const identity = identityOf(p);
    if (c.result === 'failed') {
      plan.failedCount += 1;
      continue;
    }
    if (c.result === 'whatif' && c.cmdlet === 'New-CsOnlineApplicationInstance') {
      plan.externallyCreated.push({ seq: c.seq, identity });
      continue;
    }
    if (c.result !== 'applied') continue;

    const b = (c.before ?? {}) as Partial<IdentityBeforeState>;
    const captured = b.source === 'discovery_snapshot';
    const step = (note: string, cmdlet: string, parameters: Record<string, unknown>) =>
      plan.steps.push({ seq: c.seq, note, command: renderStatement(cmdlet, parameters) });
    const cant = (reason: string) => plan.notReversible.push({ seq: c.seq, cmdlet: c.cmdlet, identity, reason });
    const notCaptured = () => cant('the previous value was not recorded (Discovery had no snapshot of this account when the run planned it)');

    if (!['user', 'cap', 'resource_account'].includes(c.object_type)) {
      cant(objectReason(c.cmdlet));
      continue;
    }

    /** Put back a previous number, or say why it can't be. */
    const restoreNumber = (prevLineUri: string) => {
      const prev = lineUriToNumber(prevLineUri)!;
      if (!b.phoneNumberType) {
        cant(
          `previous number ${prev} - its number type is not known, so reassign it by hand: ` +
            `Set-CsPhoneNumberAssignment -Identity '${identity}' -PhoneNumber '${prev}' -PhoneNumberType <CallingPlan|DirectRouting|OperatorConnect>`,
        );
        return;
      }
      step(`restore previous number ${prev}`, 'Set-CsPhoneNumberAssignment', {
        Identity: identity,
        PhoneNumber: prev,
        PhoneNumberType: b.phoneNumberType,
      });
    };

    if (c.cmdlet === 'Set-CsPhoneNumberAssignment') {
      if (!captured) {
        notCaptured();
        continue;
      }
      if (!p.PhoneNumber) {
        // Shared Calling: Enterprise Voice switched on without a number.
        if (b.enterpriseVoiceEnabled === false) {
          step('switch Enterprise Voice back off', 'Set-CsPhoneNumberAssignment', { Identity: identity, EnterpriseVoiceEnabled: false });
        }
        continue;
      }
      if (b.lineUri) {
        if (digits(b.lineUri) !== digits(String(p.PhoneNumber))) restoreNumber(b.lineUri);
      } else if (b.enterpriseVoiceEnabled === false) {
        step(`remove ${String(p.PhoneNumber)} and switch Enterprise Voice back off (had no number before)`, 'Remove-CsPhoneNumberAssignment', {
          Identity: identity,
          RemoveAll: true,
        });
      } else {
        step(`remove ${String(p.PhoneNumber)} (had no number before)`, 'Remove-CsPhoneNumberAssignment', {
          Identity: identity,
          PhoneNumber: p.PhoneNumber,
          PhoneNumberType: p.PhoneNumberType,
        });
      }
      if (p.LocationId) cant('the emergency location set with the number is not restored - check it in Teams admin center');
      continue;
    }

    if (c.cmdlet === 'Remove-CsPhoneNumberAssignment') {
      if (!captured) {
        notCaptured();
        continue;
      }
      if (b.lineUri) restoreNumber(b.lineUri);
      else if (b.enterpriseVoiceEnabled) {
        step('switch Enterprise Voice back on', 'Set-CsPhoneNumberAssignment', { Identity: identity, EnterpriseVoiceEnabled: true });
      }
      continue;
    }

    const grant = GRANT_CMDLET_POLICY[c.cmdlet];
    if (grant) {
      if (!captured || !('policyName' in b)) {
        notCaptured();
        continue;
      }
      const prev = b.policyName && !isGlobalPolicyName(b.policyName) ? b.policyName : null;
      step(`${grant.label} back to ${prev ?? 'Global'}`, c.cmdlet, { Identity: identity, PolicyName: prev ?? NULL_REF });
      continue;
    }

    if (c.cmdlet === 'Set-CsOnlineVoicemailUserSettings') {
      if (!captured || b.voicemailEnabled === undefined) {
        cant('the previous voicemail settings were not recorded (no Validate check had read them before the change)');
        continue;
      }
      step(`voicemail back ${b.voicemailEnabled ? 'on' : 'off'}`, 'Set-CsOnlineVoicemailUserSettings', {
        Identity: identity,
        VoicemailEnabled: b.voicemailEnabled,
        ...(b.voicemailEnabled && b.voicemailPromptLanguage ? { PromptLanguage: b.voicemailPromptLanguage } : {}),
      });
      continue;
    }

    if (c.cmdlet === 'New-CsUserCallingDelegate' && p.Delegate) {
      // New-CsUserCallingDelegate fails when the delegate already exists, so
      // an applied one was added by this run and removing it is the undo.
      step(`remove delegate ${String(p.Delegate)} added by this run`, 'Remove-CsUserCallingDelegate', { Identity: identity, Delegate: p.Delegate });
      continue;
    }

    if (c.cmdlet === 'Set-CsUserCallingSettings') {
      cant('previous call forwarding / call group settings are not recorded (Discovery does not read them) - restore them by hand');
      continue;
    }

    cant(objectReason(c.cmdlet));
  }
  return plan;
}

/** Comment text from tenant data must never break out of its `#` line. */
const commentSafe = (s: string) => s.replace(/[\r\n]+/g, ' ');

/**
 * The downloadable rollback .ps1. Same wrapper as renderExportScript (stop at
 * the first error, always disconnect), with a header that says plainly what it
 * does and - more importantly - what it can't put back.
 */
export function renderRollbackScript(
  changes: RollbackChangeInput[],
  opts: { deploymentId: string; finishedAt?: string | null; generatedAt?: string },
): string {
  const plan = planRollback(changes);
  const head = [
    '#Requires -Modules MicrosoftTeams',
    `# Voxshift ROLLBACK for deployment ${opts.deploymentId}${opts.finishedAt ? ` (finished ${opts.finishedAt})` : ''}`,
    `# Generated ${opts.generatedAt ?? new Date().toISOString()}. Voxshift never runs this - review every line, then run it yourself.`,
    '#',
    '# Puts back the phone number, Enterprise Voice, policy grants and voicemail settings this run changed,',
    "# newest change first. The previous values are Discovery's record of each account when the run",
    '# planned it - anything changed in Teams since then is overwritten too.',
    '# It stops at the first error; fix the cause and re-run (each command is safe to repeat).',
  ];
  if (plan.failedCount) head.push('#', `# ${plan.failedCount} command(s) in this run failed and changed nothing, so are not listed.`);

  const manual = [
    ...plan.notReversible.map((n) => `#   #${n.seq} ${n.cmdlet} ${n.identity} - ${n.reason}`),
    ...plan.externallyCreated.map(
      (e) => `#   #${e.seq} New-CsOnlineApplicationInstance ${e.identity} - resource account created by hand from the exported script, if at all; remove it in Teams admin center if it is not wanted`,
    ),
  ];
  if (manual.length) {
    head.push('#', `# NOT REVERSED BY THIS SCRIPT (${manual.length}) - undo these by hand if needed:`, ...manual);
  }

  const body = plan.steps.length
    ? plan.steps.flatMap((s) => [`  # #${s.seq}: ${s.note}`, `  ${s.command}`])
    : ['  # Nothing in this run can be reversed automatically - see the list above.'];

  return [
    ...head.map(commentSafe),
    '',
    "$ErrorActionPreference = 'Stop'",
    'Connect-MicrosoftTeams',
    'try {',
    ...body.map((l) => (l.trimStart().startsWith('#') ? commentSafe(l) : l)),
    '} finally {',
    '  Disconnect-MicrosoftTeams',
    '}',
    '',
  ].join('\n');
}
