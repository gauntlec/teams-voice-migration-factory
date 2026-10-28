import { describe, expect, it } from 'vitest';
import { portDue, portStage, portStageText, portStatusFor } from './number-port-carrier';

const range = (o: Partial<Parameters<typeof portStage>[0]> = {}) => ({ kind: 'port', port_status: null, port_submitted_to_carrier_at: null, port_foc_date: null, port_completed_at: null, ...o });

describe('port stages', () => {
  it('is only for a port-in range', () => {
    expect(portStage(range({ kind: 'new' }))).toBeNull();
    expect(portStageText(range({ kind: 'retain' }))).toBe('not applicable');
  });

  it('moves from documents to the carrier to scheduled to ported', () => {
    expect(portStage(range())).toBe('not_started');
    expect(portStage(range({ port_status: 'awaiting_documents' }))).toBe('awaiting_documents');
    expect(portStage(range({ port_status: 'complete' }))).toBe('documents_complete');
    expect(portStage(range({ port_status: 'complete', port_submitted_to_carrier_at: '2026-10-01T00:00:00Z' }))).toBe('with_carrier');
    expect(portStage(range({ port_foc_date: '2026-11-01' }))).toBe('scheduled');
    expect(portStage(range({ port_foc_date: '2026-11-01', port_completed_at: '2026-11-02T12:00:00Z' }))).toBe('ported');
  });

  it('keeps the carrier stages when a document status is written afterwards', () => {
    expect(portStatusFor(range({ port_foc_date: '2026-11-01' }), 'complete')).toBe('scheduled');
    expect(portStatusFor(range(), 'awaiting_documents')).toBe('awaiting_documents');
  });

  it('is due once the scheduled date has come and the port is not confirmed', () => {
    expect(portDue(range({ port_foc_date: '2026-11-01' }), '2026-11-01')).toBe(true);
    expect(portDue(range({ port_foc_date: '2026-11-01' }), '2026-10-31')).toBe(false);
    expect(portDue(range({ port_foc_date: '2026-11-01', port_completed_at: '2026-11-01T12:00:00Z' }), '2026-11-05')).toBe(false);
  });

  it('writes the scheduled date out', () => {
    expect(portStageText(range({ port_foc_date: '2026-11-01' }))).toBe('Port scheduled 1 Nov 2026');
  });
});
