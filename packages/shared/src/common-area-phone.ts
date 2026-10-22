/**
 * Whether a discovered account is a common area phone. Teams lists these in the user data (they have a UPN like any
 * account); what sets them apart is an active common-area-phone service plan (MCOCAP). Used by Discovery's Devices tab and
 * to route an account added to a site to the right place: Users or Common area phones.
 */
const CAP_PLAN = /MCOCAP|COMMON_?AREA/i;

export function isCommonAreaPhone(assignedPlans: unknown): boolean {
  if (!Array.isArray(assignedPlans)) return false;
  return assignedPlans.some((p) => {
    const plan = p as Record<string, unknown> | null;
    return CAP_PLAN.test(String(plan?.Capability ?? '')) && ['Enabled', 'Warning'].includes(String(plan?.CapabilityStatus ?? ''));
  });
}
