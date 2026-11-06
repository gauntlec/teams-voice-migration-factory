/**
 * A user's Teams calling settings as Get-CsUserCallingSettings returns them, in the same shape Design & Build designs them in
 * (`call_forwarding`, `pickup_group`, `delegates`). One place reads Teams' output and one place compares a design with it, so what is
 * imported from a tenant and what a deployment checks against it cannot drift apart.
 *
 * Output shape (Microsoft Learn, Get-CsUserCallingSettings): IsForwardingEnabled, ForwardingType (Immediate|Simultaneous),
 * ForwardingTarget, ForwardingTargetType (Voicemail|SingleTarget|MyDelegates|Group), IsUnansweredEnabled, UnansweredTarget,
 * UnansweredTargetType, UnansweredDelay (a time span, 00:00:20), CallGroupOrder, CallGroupTargets, Delegates / Delegators (Id and the
 * permission flags), BusyOnBusyOption. A user who never changed anything has the enabled flags empty.
 */
import type { CallDelegate, CallForwardingSettings, PickupGroupSettings } from './deployment';

export interface LiveCallingSettings {
  callForwarding: CallForwardingSettings;
  /** Only when the user has call group members; an empty group is the untouched default and is not a design. */
  pickupGroup: PickupGroupSettings | null;
  delegates: CallDelegate[];
}

type Rec = Record<string, unknown>;
const TARGET_TYPES = ['Voicemail', 'SingleTarget', 'MyDelegates', 'Group'] as const;
const FORWARDING_TYPES = ['Immediate', 'Simultaneous'] as const;
const BUSY_OPTIONS = ['PlayBusySignal', 'RedirectAsUnansweredCall', 'RingUser'] as const;

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => {
  if (typeof v === 'string') return allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (typeof v === 'number') return allowed[v];
  return undefined;
};

/** A Teams target is a `sip:` or `tel:` address; the design keeps the plain user address or number. */
export function plainTarget(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = v.trim();
  if (/^sip:/i.test(t)) return t.slice(4);
  return t;
}

/** A time span as ConvertTo-Json or Format-List gives it: "00:00:20", or { TotalSeconds } / { Hours, Minutes, Seconds }. */
export function timeSpanSeconds(v: unknown): number | undefined {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') {
    const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/.exec(v.trim());
    if (!m) return undefined;
    return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  }
  if (v && typeof v === 'object') {
    const o = v as Rec;
    if (typeof o.TotalSeconds === 'number') return Math.round(o.TotalSeconds);
    const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : 0);
    return n('Days') * 86400 + n('Hours') * 3600 + n('Minutes') * 60 + n('Seconds');
  }
  return undefined;
}

const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export function parseLiveCallingSettings(raw: unknown): LiveCallingSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const callForwarding: CallForwardingSettings = {};

  const fwdEnabled = flag(r.IsForwardingEnabled);
  if (fwdEnabled !== undefined) {
    const targetType = pick(r.ForwardingTargetType, TARGET_TYPES);
    const type = pick(r.ForwardingType, FORWARDING_TYPES);
    const target = targetType === 'SingleTarget' ? plainTarget(r.ForwardingTarget) : null;
    callForwarding.forwarding = fwdEnabled
      ? { enabled: true, ...(type ? { type } : {}), ...(targetType ? { targetType } : {}), ...(target ? { target } : {}) }
      : { enabled: false };
  }

  const unEnabled = flag(r.IsUnansweredEnabled);
  if (unEnabled !== undefined) {
    const targetType = pick(r.UnansweredTargetType, TARGET_TYPES);
    const target = targetType === 'SingleTarget' ? plainTarget(r.UnansweredTarget) : null;
    const seconds = timeSpanSeconds(r.UnansweredDelay);
    callForwarding.unanswered = unEnabled
      ? {
          enabled: true,
          ...(seconds !== undefined ? { delaySeconds: Math.min(60, Math.max(5, seconds)) } : {}),
          ...(targetType ? { targetType } : {}),
          ...(target ? { target } : {}),
        }
      : { enabled: false };
  }

  const busy = pick(r.BusyOnBusyOption, BUSY_OPTIONS);
  if (busy) callForwarding.busyOnBusy = busy;

  const groupTargets = (Array.isArray(r.CallGroupTargets) ? r.CallGroupTargets : []).map(plainTarget).filter((v): v is string => !!v);
  const order = pick(r.CallGroupOrder, ['Simultaneous', 'InOrder'] as const);
  const pickupGroup: PickupGroupSettings | null = groupTargets.length && order ? { order, targets: groupTargets } : null;

  const delegates: CallDelegate[] = [];
  for (const d of Array.isArray(r.Delegates) ? (r.Delegates as unknown[]) : []) {
    if (!d || typeof d !== 'object') continue;
    const o = d as Rec;
    const id = plainTarget(o.Id);
    if (!id) continue;
    delegates.push({
      delegateUpn: id,
      makeCalls: o.MakeCalls === true,
      receiveCalls: o.ReceiveCalls === true,
      manageSettings: o.ManageSettings === true,
      pickUpHeldCalls: o.PickUpHeldCalls === true,
      joinActiveCalls: o.JoinActiveCalls === true,
    });
  }
  return { callForwarding, pickupGroup, delegates };
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** Does the designed forwarding setting already hold in Teams? Only compares what the design sets. */
export function forwardingMatchesLive(design: NonNullable<CallForwardingSettings['forwarding']>, live: CallForwardingSettings['forwarding'] | undefined): boolean {
  if (!design.enabled) return live ? live.enabled === false : true;
  return !!live && live.enabled && live.type === design.type && live.targetType === design.targetType && (design.targetType !== 'SingleTarget' || same(plainTarget(live.target), plainTarget(design.target)));
}

/** The ring times Teams offers before an unanswered call moves on. */
export const UNANSWERED_DELAYS = [5, 10, 15, 20, 30, 40, 50, 60] as const;

type UnansweredSetting = NonNullable<CallForwardingSettings['unanswered']>;

/**
 * Teams leaves a user's unanswered calls with nowhere to go ("If unanswered: Do nothing"), even with voicemail on, so a caller never reaches
 * it. Voxshift's default is Microsoft's documented one: voicemail after 20 seconds (Set-CsUserCallingSettings, Learn's Example 10).
 */
export const VOICEMAIL_UNANSWERED_DEFAULT = { enabled: true, delaySeconds: 20, targetType: 'Voicemail' } as const satisfies UnansweredSetting;

/** What applies when nothing has been chosen for a user. */
export function defaultUnanswered(voicemailOn: boolean): UnansweredSetting {
  return voicemailOn ? VOICEMAIL_UNANSWERED_DEFAULT : { enabled: false };
}

const sameUnanswered = (a: UnansweredSetting, b: UnansweredSetting) =>
  a.enabled === b.enabled && (!a.enabled || ((a.delaySeconds ?? 20) === (b.delaySeconds ?? 20) && a.targetType === b.targetType && (a.target ?? '') === (b.target ?? '')));

/**
 * A row's call forwarding with this choice for unanswered calls. Choosing what the default already gives stores nothing, so the row
 * keeps following voicemail being turned on or off; anything else is stored as that row's own choice.
 */
export function setUnansweredChoice(settings: CallForwardingSettings, next: UnansweredSetting, voicemailOn: boolean): CallForwardingSettings {
  const { unanswered: _old, ...rest } = settings;
  return sameUnanswered(next, defaultUnanswered(voicemailOn)) ? rest : { ...rest, unanswered: next };
}

export function unansweredMatchesLive(design: NonNullable<CallForwardingSettings['unanswered']>, live: CallForwardingSettings['unanswered'] | undefined): boolean {
  if (!design.enabled) return live ? live.enabled === false : true;
  return (
    !!live &&
    live.enabled &&
    (live.delaySeconds ?? 20) === (design.delaySeconds ?? 20) &&
    live.targetType === design.targetType &&
    (design.targetType !== 'SingleTarget' || same(plainTarget(live.target), plainTarget(design.target)))
  );
}

export function pickupGroupMatchesLive(design: PickupGroupSettings, live: PickupGroupSettings | null): boolean {
  const a = design.targets.map((t) => (plainTarget(t) ?? '').toLowerCase());
  const b = (live?.targets ?? []).map((t) => (plainTarget(t) ?? '').toLowerCase());
  if (a.length === 0 && b.length === 0) return true;
  return !!live && design.order === live.order && a.length === b.length && a.every((t, i) => t === b[i]);
}

export function delegateMatchesLive(design: CallDelegate, live: CallDelegate[]): boolean {
  const hit = live.find((l) => same(plainTarget(l.delegateUpn), plainTarget(design.delegateUpn)));
  return !!hit && hit.makeCalls === design.makeCalls && hit.receiveCalls === design.receiveCalls && hit.manageSettings === design.manageSettings && hit.pickUpHeldCalls === design.pickUpHeldCalls && hit.joinActiveCalls === design.joinActiveCalls;
}
