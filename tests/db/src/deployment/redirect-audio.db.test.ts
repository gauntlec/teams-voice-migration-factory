// Redirect audio prompts on a call queue: uploaded to the database, planned as a placeholder, imported to Teams by the worker in
// the live run, then matched against live by the Teams id.
import { beforeAll, describe, expect, it } from 'vitest';
import { previewSiteChanges } from '@tvmf/db';
import type { CmdletInvocation } from '@tvmf/shared';
import { resolveAudioPlaceholders } from '../../../../apps/worker/src/deployment-audio';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { seedCustomer, seedSite, seedUser, unused, useDb, type TestCustomer } from '../helpers';

const handle = useDb();
let c: TestCustomer;
let build: BuildService;
let siteId: string;
let fileId: string;
const SUPPORT = '11111111-1111-4111-8111-111111111111';
const actor = (u: { id: string; email: string }) => ({ id: u.id, email: u.email, role: 'ENGINEER' }) as never;

beforeAll(async () => {
  c = await seedCustomer(handle);
  const eng = await seedUser(handle, 'ENGINEER');
  build = new BuildService(handle.db, new AuditService(handle.db), unused('validation'), unused('discovery'), unused('documentBuilder'), unused('files'));
  siteId = (await seedSite(c.s)).id;
  const up = await build.uploadAudioFile(c.t, actor(eng), { originalname: 'transfer.wav', mimetype: 'audio/wav', buffer: Buffer.from('RIFF....WAVE'), size: 12 });
  fileId = up.id;
  await c.s
    .insertInto('build_call_queues')
    .values({ site_id: siteId, name: 'Sales', routing_method: 'RoundRobin', agent_alert_time: 20, presence_based_routing: true, agents: '[]', resource_accounts: '[]', overflow: JSON.stringify({ action: 'Forward', threshold: 10, target: SUPPORT, redirectAudio: { fileId, filename: 'transfer.wav' } }), timeout: '{}', no_agent_action: '{}' } as never)
    .execute();
  await c.s
    .insertInto('tenant_objects')
    .values({ object_type: 'call_queue', object_key: 'q1', display_name: 'Sales', data: JSON.stringify({ Identity: 'q1', Name: 'Sales', RoutingMethod: 'RoundRobin', AgentAlertTime: 20, PresenceBasedRouting: true, Agents: [], OverflowAction: 'Forward', OverflowThreshold: 10, OverflowActionTarget: { Id: SUPPORT } }) } as never)
    .execute();
});

const plan = async () => (await previewSiteChanges(c.s, { siteId, sheets: ['call_queues'] })).flatMap((r) => r.calls);

describe('redirect audio prompts', () => {
  it('refuses a file Teams would not play', async () => {
    await expect(build.uploadAudioFile(c.t, actor({ id: '00000000-0000-4000-8000-000000000001', email: 'x@y' }), { originalname: 'notes.txt', mimetype: 'text/plain', buffer: Buffer.from('x'), size: 1 })).rejects.toThrow(/WAV, MP3 or WMA/);
  });

  it('plans a placeholder until imported; the worker imports it and swaps in the Teams id', async () => {
    const [call] = await plan();
    expect(call!.parameters.OverflowRedirectPersonAudioFilePrompt).toBe(`<audio:${fileId}>`);
    const recorded: { cmdlet: string; result: string }[] = [];
    const record = async (cl: CmdletInvocation, res: { result: string }) => void recorded.push({ cmdlet: cl.cmdlet, result: res.result });

    const dry = await resolveAudioPlaceholders(c.s, { importAudioFile: async () => 'never' }, true, call!, record as never);
    expect(dry.call.parameters.OverflowRedirectPersonAudioFilePrompt).toBe(`<audio:${fileId}>`);

    const seen: Buffer[] = [];
    const live = await resolveAudioPlaceholders(c.s, { importAudioFile: async (_a, _n, content) => (seen.push(content), 'teams-audio-1') }, false, call!, record as never);
    expect(live.call.parameters.OverflowRedirectPersonAudioFilePrompt).toBe('teams-audio-1');
    expect(live.imported).toEqual([fileId]);
    expect(seen[0]!.toString()).toBe('RIFF....WAVE');
    expect(recorded).toEqual([{ cmdlet: 'Import-CsOnlineAudioFile', result: 'applied' }]);
  });

  it('plans nothing once Teams has that file on the queue', async () => {
    await c.s.updateTable('tenant_objects').set({ data: JSON.stringify({ Identity: 'q1', Name: 'Sales', RoutingMethod: 'RoundRobin', AgentAlertTime: 20, PresenceBasedRouting: true, Agents: [], OverflowAction: 'Forward', OverflowThreshold: 10, OverflowActionTarget: { Id: SUPPORT }, OverflowRedirectPersonAudioFilePrompt: 'teams-audio-1' }) } as never).where('object_key', '=', 'q1').execute();
    expect(await plan()).toEqual([]);
  });
});
