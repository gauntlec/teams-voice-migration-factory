/*
 * Scheduled cutover: a live run that starts at a set time on the engineer's live sign-in. No customer credentials are stored, so
 * the run can only start while that sign-in is alive: the worker keeps it alive while a scheduled run waits, but a worker restart
 * (an update) ends it. These rules decide what start time is allowed.
 */

/** How far ahead a run can be scheduled: a change window tonight or tomorrow morning, not next week. */
export const SCHEDULED_RUN_MAX_HOURS = 24;

/** Why a start time cannot be used, or null if it can. `maintenanceAt` = a planned update that would restart the worker. */
export function scheduledRunProblem(runAt: string, now: Date, maintenanceAt: string | null): string | null {
  const at = Date.parse(runAt);
  if (Number.isNaN(at)) return 'The start time could not be read.';
  if (at < now.getTime() + 60_000) return 'Choose a start time at least a minute from now, or deploy now instead.';
  if (at > now.getTime() + SCHEDULED_RUN_MAX_HOURS * 3_600_000) {
    return `A run can be scheduled up to ${SCHEDULED_RUN_MAX_HOURS} hours ahead: the sign-in to the customer tenant has to stay alive until it starts.`;
  }
  if (maintenanceAt) {
    const m = Date.parse(maintenanceAt);
    if (m > now.getTime() && m <= at) {
      return `A Voxshift update is planned for ${new Date(m).toISOString().replace('T', ' ').slice(0, 16)} UTC, before this run: the restart would end the sign-in. Schedule it before the update, or after it with a new sign-in.`;
    }
  }
  return null;
}
