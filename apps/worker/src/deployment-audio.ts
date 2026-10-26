import { AUDIO_PLACEHOLDER, type CmdletInvocation } from '@tvmf/shared';
import type { Scoped } from '@tvmf/db';
import type { CmdletResult, TeamsExecutor } from './teams/executor';

/**
 * Swaps each redirect audio placeholder (`<audio:id>`, see callQueueActionExtras) in a call queue command for a Teams audio file
 * id. A live run imports the file now (Import-CsOnlineAudioFile, recorded like any command) so the queue uses it well inside the
 * 48 hours Teams keeps an unused import; a What-If (or a read-only tenant) leaves the placeholder in the script. Returns the
 * voice_audio_files ids it imported, so the caller can forget them again if the queue command then fails.
 */
export async function resolveAudioPlaceholders(
  s: Scoped,
  exec: Pick<TeamsExecutor, 'importAudioFile'>,
  dryRun: boolean,
  call: CmdletInvocation,
  record: (call: CmdletInvocation, res: CmdletResult) => Promise<void>,
): Promise<{ call: CmdletInvocation; imported: string[] }> {
  const imported: string[] = [];
  if (dryRun || !exec.importAudioFile) return { call, imported };
  const parameters = { ...call.parameters };
  for (const [key, value] of Object.entries(parameters)) {
    const m = typeof value === 'string' ? AUDIO_PLACEHOLDER.exec(value) : null;
    if (!m) continue;
    const file = await s.selectFrom('voice_audio_files').select(['id', 'filename', 'content']).where('id', '=', m[1]!).executeTakeFirst();
    if (!file) continue;
    const importCall: CmdletInvocation = { cmdlet: 'Import-CsOnlineAudioFile', parameters: { ApplicationId: 'HuntGroup', FileName: file.filename }, objectType: call.objectType, objectId: call.objectId };
    try {
      const id = await exec.importAudioFile('HuntGroup', file.filename, file.content);
      await record(importCall, { result: 'applied', before: {}, after: { Id: id } });
      await s.updateTable('voice_audio_files').set({ teams_audio_file_id: id, imported_at: new Date().toISOString() }).where('id', '=', file.id).execute();
      parameters[key] = id;
      imported.push(file.id);
    } catch (e) {
      await record(importCall, { result: 'failed', before: {}, after: {}, message: `Import-CsOnlineAudioFile ${file.filename}: ${(e as Error).message}` });
    }
  }
  return { call: { ...call, parameters }, imported };
}
