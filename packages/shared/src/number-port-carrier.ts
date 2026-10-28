/*
 * The carrier side of a port-in range. A 'port' range is with one carrier now (`carrier`) and moving to another (`new_carrier`).
 * After the documents are in (see number_port_requests), the port goes to the new carrier, gets a scheduled date (FOC), and on that
 * day completes - which switches the range's carrier to the new one.
 */

export type PortStage = 'not_started' | 'awaiting_documents' | 'documents_complete' | 'with_carrier' | 'scheduled' | 'ported';

export const PORT_STAGE_LABELS: Record<PortStage, string> = {
  not_started: 'Not started',
  awaiting_documents: 'Waiting for documents',
  documents_complete: 'Documents complete',
  with_carrier: 'With the new carrier',
  scheduled: 'Port scheduled',
  ported: 'Ported',
};

export interface PortRangeState {
  kind: string;
  /** the document workflow's mirror on the range: awaiting_documents | complete */
  port_status: string | null;
  port_submitted_to_carrier_at: string | null;
  port_foc_date: string | null;
  port_completed_at: string | null;
}

/** Where a range is in its port, or null when it is not a port-in range. */
export function portStage(r: PortRangeState): PortStage | null {
  if (r.kind !== 'port') return null;
  if (r.port_completed_at) return 'ported';
  if (r.port_foc_date) return 'scheduled';
  if (r.port_submitted_to_carrier_at) return 'with_carrier';
  if (r.port_status === 'complete') return 'documents_complete';
  if (r.port_status === 'awaiting_documents') return 'awaiting_documents';
  return 'not_started';
}

/** The stage as the range's `port_status` stores it: the carrier stages replace the document ones once reached. */
export function portStatusFor(r: PortRangeState, documentsStatus: string | null): string | null {
  const stage = portStage({ ...r, port_status: documentsStatus });
  return stage === 'with_carrier' || stage === 'scheduled' || stage === 'ported' ? stage : documentsStatus;
}

/** The scheduled port date has come (today or earlier) and nobody has confirmed the port yet. `today` is YYYY-MM-DD. */
export function portDue(r: PortRangeState, today: string): boolean {
  return r.kind === 'port' && !r.port_completed_at && !!r.port_foc_date && r.port_foc_date.slice(0, 10) <= today;
}

/** What the Port status column says, e.g. "Port scheduled 28 Oct 2026". */
export function portStageText(r: PortRangeState): string {
  const stage = portStage(r);
  if (!stage) return 'not applicable';
  const date = (v: string | null) => (v ? new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  if (stage === 'scheduled') return `${PORT_STAGE_LABELS.scheduled} ${date(r.port_foc_date)}`;
  if (stage === 'ported') return `${PORT_STAGE_LABELS.ported} ${date(r.port_completed_at)}`;
  return PORT_STAGE_LABELS[stage];
}
