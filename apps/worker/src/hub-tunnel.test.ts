import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Kysely } from 'kysely';
import { WebSocketServer } from 'ws';
import type { DB } from '@tvmf/db';
import { encryptSecret } from './crypto';
import { HubTunnel } from './hub-tunnel';

/** Just enough of Kysely for the connector: every builder call chains, the settings row comes back, writes resolve. */
function fakeDb(row: Record<string, unknown>): Kysely<DB> {
  const chain: unknown = new Proxy(() => chain, {
    get: (_t, prop) => (prop === 'executeTakeFirst' ? async () => row : prop === 'execute' ? async () => [] : prop === 'then' ? undefined : chain),
    apply: () => chain,
  });
  return chain as Kysely<DB>;
}

describe('HubTunnel', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.DATA_ENCRYPTION_KEY;
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = saved;
  });

  it('dials again when the hub goes silent without closing the connection', async () => {
    // A hub that accepts the connection and then says nothing, as when a proxy in between restarts and drops it without a close.
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    let connections = 0;
    const second = new Promise<void>((resolve) => wss.on('connection', () => ++connections === 2 && resolve()));
    const { port } = wss.address() as AddressInfo;
    const tunnel = new HubTunnel(fakeDb({ hub_url: `http://127.0.0.1:${port}`, hub_token_enc: encryptSecret('token'), hub_remote_access: true }), {
      silenceMs: 300,
      backoffStartMs: 50,
    });
    try {
      tunnel.start();
      await Promise.race([second, new Promise((_, reject) => setTimeout(() => reject(new Error('never dialled again')), 5_000))]);
      expect(connections).toBe(2);
    } finally {
      tunnel.stop();
      wss.close();
    }
  });

  it('keeps a connection the hub keeps pinging', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    let connections = 0;
    wss.on('connection', (ws) => {
      connections += 1;
      const t = setInterval(() => ws.ping(), 100);
      ws.on('close', () => clearInterval(t));
    });
    const { port } = wss.address() as AddressInfo;
    const tunnel = new HubTunnel(fakeDb({ hub_url: `http://127.0.0.1:${port}`, hub_token_enc: encryptSecret('token'), hub_remote_access: true }), {
      silenceMs: 300,
      backoffStartMs: 50,
    });
    try {
      tunnel.start();
      await new Promise((r) => setTimeout(r, 1_200));
      expect(connections).toBe(1);
    } finally {
      tunnel.stop();
      wss.close();
    }
  });
});
