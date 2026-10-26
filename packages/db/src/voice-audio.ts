import type { CallQueueActionSettings } from '@tvmf/shared';
import type { Scoped } from './live-state';

/*
 * Redirect audio prompts (migration 0069): which uploaded file each call queue exception plays, and the Teams audio file id it
 * was last imported as. Shared by the deployment preview and the worker, so both plan the same commands.
 */

/** The voice_audio_files ids a batch of call queue rows' exceptions refer to. */
export function referencedAudioFileIds(rows: { overflow?: unknown; timeout?: unknown; no_agent_action?: unknown }[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    for (const a of [r.overflow, r.timeout, r.no_agent_action] as (CallQueueActionSettings | null | undefined)[]) {
      if (a?.redirectAudio?.fileId) ids.add(a.redirectAudio.fileId);
    }
  }
  return [...ids];
}

/** voice_audio_files.id -> the Teams audio file id it was imported as, for those already imported. */
export async function audioImportMap(s: Scoped, rows: { overflow?: unknown; timeout?: unknown; no_agent_action?: unknown }[]): Promise<Map<string, string>> {
  const ids = referencedAudioFileIds(rows);
  if (!ids.length) return new Map();
  const found = await s.selectFrom('voice_audio_files').select(['id', 'teams_audio_file_id']).where('id', 'in', ids).where('teams_audio_file_id', 'is not', null).execute();
  return new Map(found.map((f) => [f.id, f.teams_audio_file_id!]));
}
