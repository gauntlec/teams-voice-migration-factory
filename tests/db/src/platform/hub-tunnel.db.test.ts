// The connector (apps/worker/src/hub-tunnel.ts): while the customer's switch is on it holds one OUTBOUND connection to the hub and answers
// requests from this installation's own web server, and nothing else. Off means off.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { platformDb } from '@tvmf/db';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import { PlatformSettingsService } from '../../../../apps/api/src/platform-ops/platform-settings.service';
import { sendHubHeartbeat } from '../../../../apps/worker/src/hub-heartbeat';
import { hubVersion } from '../../../../apps/worker/src/hub-heartbeat';
import { HubTunnel } from '../../../../apps/worker/src/hub-tunnel';
import { seedUser, useDb, useGlobalSettingsLock } from '../helpers';

const handle = useDb();
useGlobalSettingsLock(handle);
const TOKEN = `vxh_b04e6c2c-d276-4c12-a477-0554a8b34d20_${'cd34'.repeat(12)}`;
const cfg = { WEB_ORIGIN: 'http://localhost:5173', REFRESH_COOKIE: 'tvmf_rt' } as AppConfig;
let svc: PlatformSettingsService;
let admin: Awaited<ReturnType<typeof seedUser>>;

/** A hub that accepts connectors: remembers who connected, and lets a test send requests down the tunnel. */
async function startFakeHub() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/api/v1/tunnel' });
  await new Promise<void>((r) => wss.on('listening', r));
  const state = { sockets: [] as WebSocket[], auth: [] as string[], frames: [] as Record<string, any>[], closeWith: 0 };
  wss.on('connection', (ws, req) => {
    state.auth.push(String(req.headers.authorization));
    if (state.closeWith) return void ws.close(state.closeWith, 'refused');
    state.sockets.push(ws);
    ws.on('message', (raw) => state.frames.push(JSON.parse(raw.toString())));
  });
  return { wss, state, port: (wss.address() as AddressInfo).port, url: () => `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

/** The installation's own web server. */
async function startWeb() {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === '/big') {
        res.writeHead(200);
        for (let i = 0; i < 30; i++) res.write(Buffer.alloc(100_000, i));
        return void res.end();
      }
      if (req.url === '/cookies') {
        res.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
        return void res.end('ok');
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-instance': 'yes' });
      res.end(`got ${req.method} ${req.url} (${Buffer.concat(chunks).length} bytes)`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting');
};
const tunnelState = async () => (await svc.view()).hub;

/** Sends one request down the tunnel and collects the answer. */
function ask(ws: WebSocket, frames: Record<string, any>[], id: string, req: { method: string; path: string; headers?: [string, string][] }, body?: Buffer) {
  ws.send(JSON.stringify({ t: 'req', id, method: req.method, path: req.path, headers: req.headers ?? [['host', 'otwc.hub.test']] }));
  if (body) ws.send(JSON.stringify({ t: 'body', id, data: body.toString('base64'), end: false }));
  ws.send(JSON.stringify({ t: 'body', id, data: '', end: true }));
  return until(() => frames.some((f) => f.id === id && (f.t === 'err' || (f.t === 'body' && f.end)))).then(() => {
    const mine = frames.filter((f) => f.id === id);
    const res = mine.find((f) => f.t === 'res');
    const err = mine.find((f) => f.t === 'err');
    const data = Buffer.concat(mine.filter((f) => f.t === 'body' && f.data).map((f) => Buffer.from(f.data, 'base64')));
    return { res, err, data };
  });
}

beforeAll(async () => {
  admin = await seedUser(handle, 'SUPER_ADMIN');
  svc = new PlatformSettingsService(handle.db, cfg);
});
afterAll(async () => {
  await platformDb(handle.db).deleteFrom('app_settings').execute();
});

describe('the customer controls remote access', () => {
  it('is off until someone on this installation turns it on, and needs a connected hub', async () => {
    await platformDb(handle.db).deleteFrom('app_settings').execute();
    expect((await svc.view()).hub).toMatchObject({ connected: false, remoteAccess: false, tunnelState: 'off' });
    await svc.setHubRemoteAccess(true, admin.id); // no hub connected: nothing to switch
    expect((await svc.view()).hub.remoteAccess).toBe(false);
    const hub = await startFakeHub();
    await svc.connectHub(hub.url(), TOKEN, admin.id);
    expect((await svc.view()).hub).toMatchObject({ connected: true, remoteAccess: false });
    const t = new HubTunnel(handle.db, { target: 'http://127.0.0.1:1' });
    await t.reconcile();
    expect(hub.state.auth).toHaveLength(0); // switch off: it never even dials out
    t.stop();
    await hub.close();
  });
});

describe('the connector', () => {
  let hub: Awaited<ReturnType<typeof startFakeHub>>;
  let web: Awaited<ReturnType<typeof startWeb>>;
  let tunnel: HubTunnel;

  beforeAll(async () => {
    hub = await startFakeHub();
    web = await startWeb();
    await svc.connectHub(hub.url(), TOKEN, admin.id);
    await svc.setHubRemoteAccess(true, admin.id);
    tunnel = new HubTunnel(handle.db, { target: web.url, backoffStartMs: 50 });
  });
  afterAll(async () => {
    tunnel.stop();
    await web.close();
    await hub.close();
  });

  it('dials out with the token and says hello once the switch is on', async () => {
    await tunnel.reconcile();
    await until(() => hub.state.sockets.length === 1);
    expect(hub.state.auth[0]).toBe(`Bearer ${TOKEN}`);
    await until(() => hub.state.frames.some((f) => f.t === 'hello'));
    expect(hub.state.frames.find((f) => f.t === 'hello')!.version).toBe(hubVersion());
    await until(async () => (await tunnelState()).tunnelState === 'connected');
  });

  it('answers requests from its own web server: methods, headers, bodies, cookies, large responses', async () => {
    const ws = hub.state.sockets[0]!;
    const get = await ask(ws, hub.state.frames, 'g1', { method: 'GET', path: '/hello?x=1', headers: [['host', 'otwc.hub.test'], ['x-forwarded-for', '203.0.113.5'], ['cookie', 'tvmf_rt=abc']] });
    expect(get.res!.status).toBe(200);
    expect(get.data.toString()).toBe('got GET /hello?x=1 (0 bytes)');
    expect(web.seen.at(-1)!.headers).toMatchObject({ host: 'otwc.hub.test', 'x-forwarded-for': '203.0.113.5', cookie: 'tvmf_rt=abc' });
    expect(get.res!.headers).toContainEqual(['x-instance', 'yes']);

    const up = await ask(ws, hub.state.frames, 'p1', { method: 'POST', path: '/upload' }, Buffer.alloc(300_000, 9));
    expect(up.data.toString()).toBe('got POST /upload (300000 bytes)');

    const big = await ask(ws, hub.state.frames, 'b1', { method: 'GET', path: '/big' });
    expect(big.data.length).toBe(3_000_000);

    const c = await ask(ws, hub.state.frames, 'c1', { method: 'GET', path: '/cookies' });
    expect(c.res!.headers.filter(([k]: [string, string]) => k.toLowerCase() === 'set-cookie').map(([, v]: [string, string]) => v)).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('only ever talks to its own web server: the hub cannot name another host, scheme or odd method', async () => {
    const ws = hub.state.sockets[0]!;
    const before = web.seen.length;
    for (const [id, req] of [
      ['e1', { method: 'GET', path: '//evil.example.com/x' }],
      ['e2', { method: 'GET', path: 'http://evil.example.com/' }],
      ['e3', { method: 'CONNECT', path: '/x' }],
      ['e4', { method: 'GET', path: 'x' }],
    ] as const) {
      const r = await ask(ws, hub.state.frames, id, req);
      expect(r.err, id).toBeDefined();
    }
    expect(web.seen.length).toBe(before);
  });

  it('tells the hub when its own web server is not answering', async () => {
    const dead = new HubTunnel(handle.db, { target: 'http://127.0.0.1:1', backoffStartMs: 50 });
    const probe = await startFakeHub();
    await svc.connectHub(probe.url(), TOKEN, admin.id);
    await svc.setHubRemoteAccess(true, admin.id);
    await dead.reconcile();
    await until(() => probe.state.sockets.length === 1);
    const r = await ask(probe.state.sockets[0]!, probe.state.frames, 'd1', { method: 'GET', path: '/' });
    expect(r.err!.message).toMatch(/did not answer/);
    dead.stop();
    await probe.close();
    await svc.connectHub(hub.url(), TOKEN, admin.id);
    await svc.setHubRemoteAccess(true, admin.id);
  });

  it('closes the connection within a moment of the switch being turned off, and reports the heartbeat flag', async () => {
    const beats: Record<string, unknown>[] = [];
    const fetchFn = (async (_u: string, init: { body: string }) => (beats.push(JSON.parse(init.body)), { ok: true, status: 200 })) as unknown as typeof fetch;
    await sendHubHeartbeat(handle.db, { fetchFn });
    expect(beats.at(-1)).toMatchObject({ remoteAccess: true });

    const first = hub.state.sockets.length;
    await svc.setHubRemoteAccess(false, admin.id);
    await tunnel.reconcile();
    await until(() => hub.state.sockets.at(-1)!.readyState === 3); // closed
    await until(async () => (await tunnelState()).tunnelState === 'off');
    expect(hub.state.sockets.length).toBe(first); // and it did not dial back in

    await sendHubHeartbeat(handle.db, { fetchFn });
    expect(beats.at(-1)).toMatchObject({ remoteAccess: false });
  });

  it('explains a refused token in words and keeps retrying; switching on again reconnects', async () => {
    hub.state.closeWith = 4401;
    await svc.setHubRemoteAccess(true, admin.id);
    await tunnel.reconcile();
    await until(async () => (await tunnelState()).tunnelState === 'error');
    expect((await tunnelState()).tunnelError).toMatch(/does not accept/);

    hub.state.closeWith = 0; // the token is fixed hub-side: the next retry gets through
    await until(async () => (await tunnelState()).tunnelState === 'connected', 6000);
    expect((await tunnelState()).tunnelError).toBeNull();
  });
});
