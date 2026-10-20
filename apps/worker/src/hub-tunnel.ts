import http from 'node:http';
import type { Kysely } from 'kysely';
import WebSocket from 'ws';
import { platformDb, type DB } from '@tvmf/db';
import { tunnelCloseText, type HubTunnelState } from '@tvmf/shared';
import { decryptSecret } from './crypto';
import { hubVersion } from './hub-heartbeat';

/**
 * The connector: while the CUSTOMER's remote-access switch is on (Administration > Platform settings > Voxshift hub) this keeps one OUTBOUND
 * WebSocket open to the hub, so the people the hub allows (anyone with a hub account who has been given access to this installation) can open it without any inbound firewall rule or VPN. The hub sends each
 * browser request down it; this answers from the installation's own web server and nothing else (the target is fixed, never chosen by the hub).
 * Customer data passes through to the signed-in person's browser and is not kept by either side.
 *
 * Frames are JSON text messages (bodies are base64), matching the hub's tunnel:
 *   hub -> here:  { t:'req', id, method, path, headers: [[name, value], ...] }  then  { t:'body', id, data, end }  or  { t:'abort', id }
 *   here -> hub:  { t:'hello', version }  { t:'res', id, status, headers: [[name, value], ...] }  { t:'body', id, data, end }  { t:'err', id, message }
 */
const CHUNK_BYTES = 64 * 1024;
const RECONCILE_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
/** Stop reading the instance's response while this much is waiting to be sent to the hub. */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

type Frame = { t?: string; id?: string; method?: string; path?: string; headers?: [string, string][]; data?: string; end?: boolean };

export interface TunnelOptions {
  /** The installation's own web server (nginx, which also serves /api). Fixed by configuration, never by the hub. */
  target?: string;
  /** For tests: when to retry after a drop, in ms. */
  backoffStartMs?: number;
}

export class HubTunnel {
  private socket: WebSocket | null = null;
  private fingerprint = '';
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private backoff: number;
  private readonly backoffStart: number;
  /** State writes go one after another, so a slow 'connected' can never land after the 'error' that followed it. */
  private writes: Promise<void> = Promise.resolve();
  private state: HubTunnelState | null = null;
  private stateError: string | null = null;
  private busy = false;
  private target: URL;

  constructor(private db: Kysely<DB>, opts: TunnelOptions = {}) {
    this.target = new URL(opts.target ?? process.env.HUB_TUNNEL_TARGET ?? 'http://web:80');
    this.backoffStart = opts.backoffStartMs ?? 2_000;
    this.backoff = this.backoffStart;
  }

  start(): void {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
    this.timer = this.retry = null;
    this.socket?.close(1000);
    this.socket = null;
  }

  /** Brings the connection in line with the settings: up while the switch is on and a hub is connected, down otherwise. Safe to call often. */
  async reconcile(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const row = await platformDb(this.db).selectFrom('app_settings').select(['hub_url', 'hub_token_enc', 'hub_remote_access']).executeTakeFirst();
      if (!row?.hub_url || !row.hub_token_enc || !row.hub_remote_access) {
        this.disconnect();
        await this.setState('off', null);
        return;
      }
      const fp = `${row.hub_url}|${row.hub_token_enc}`;
      if (this.socket && this.fingerprint !== fp) this.disconnect(); // pointed at another hub, or a new token
      if (!this.socket && !this.retry) this.connect(row.hub_url, decryptSecret(row.hub_token_enc), fp);
    } catch (err) {
      console.warn('hub tunnel reconcile failed', (err as Error).message);
    } finally {
      this.busy = false;
    }
  }

  private disconnect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const s = this.socket;
    this.socket = null;
    s?.removeAllListeners('close');
    s?.close(1000);
  }

  private connect(hubUrl: string, token: string, fp: string): void {
    this.fingerprint = fp;
    void this.setState('connecting', null);
    const url = `${hubUrl.replace(/^http/, 'ws')}/api/v1/tunnel`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 15_000, perMessageDeflate: false });
    this.socket = socket;
    const live = new Map<string, http.ClientRequest>();
    let opened = false;

    socket.on('open', () => {
      opened = true;
      this.backoff = this.backoffStart;
      socket.send(JSON.stringify({ t: 'hello', version: hubVersion() }));
      void this.setState('connected', null);
    });
    socket.on('message', (raw) => {
      let f: Frame;
      try {
        f = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (f.t === 'req') this.onRequest(socket, live, f);
      else if (f.t === 'body') {
        const r = f.id ? live.get(f.id) : undefined;
        if (!r) return;
        if (f.data) r.write(Buffer.from(f.data, 'base64'));
        if (f.end) r.end();
      } else if (f.t === 'abort' && f.id) {
        live.get(f.id)?.destroy();
        live.delete(f.id);
      }
    });
    const lost = (message: string) => {
      for (const r of live.values()) r.destroy();
      live.clear();
      if (this.socket !== socket) return; // already replaced or switched off on purpose
      this.socket = null;
      void this.setState('error', message);
      // A rejected token will not get better by hammering: wait longer. Otherwise back off gently and try again.
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.reconcile();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
    socket.on('close', (code) => lost(opened || code ? tunnelCloseText(code) : 'Could not reach the hub.'));
    socket.on('error', (err) => lost(`Could not reach the hub: ${err.message.slice(0, 120)}.`));
  }

  private onRequest(socket: WebSocket, live: Map<string, http.ClientRequest>, f: Frame): void {
    const id = f.id;
    if (!id) return;
    const fail = (message: string) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ t: 'err', id, message }));
    const method = String(f.method ?? '').toUpperCase();
    // Only plain paths on the installation's own web server: nothing the hub sends can name another host or scheme.
    if (!ALLOWED_METHODS.has(method) || typeof f.path !== 'string' || !f.path.startsWith('/') || f.path.startsWith('//')) return void fail('That request is not allowed.');
    // Header names come from the hub: keep only valid header names (so "__proto__" and the like never become a property name) and build the
    // list in a Map first.
    const merged = new Map<string, string>();
    for (const [k, v] of f.headers ?? []) {
      const name = String(k).toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
      const before = merged.get(name);
      merged.set(name, before ? `${before}, ${v}` : String(v));
    }
    const headers: Record<string, string> = Object.fromEntries(merged);
    const req = http.request(
      { host: this.target.hostname, port: this.target.port || 80, method, path: f.path, headers },
      (res) => {
        const out: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) out.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
        socket.send(JSON.stringify({ t: 'res', id, status: res.statusCode ?? 502, headers: out }));
        res.on('data', (chunk: Buffer) => {
          for (let i = 0; i < chunk.length; i += CHUNK_BYTES) socket.send(JSON.stringify({ t: 'body', id, data: chunk.subarray(i, i + CHUNK_BYTES).toString('base64'), end: false }));
          // Do not read the instance faster than the hub can take it.
          if (socket.bufferedAmount > HIGH_WATER_BYTES) {
            res.pause();
            const poll = setInterval(() => {
              if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount < HIGH_WATER_BYTES / 2) {
                clearInterval(poll);
                res.resume();
              }
            }, 25);
          }
        });
        res.on('end', () => {
          live.delete(id);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'body', id, data: '', end: true }));
        });
      },
    );
    req.on('error', (e) => {
      live.delete(id);
      fail(`The installation did not answer (${e.message.slice(0, 80)}).`);
    });
    live.set(id, req);
  }

  private async setState(state: HubTunnelState, error: string | null): Promise<void> {
    if (state === this.state && error === this.stateError) return;
    this.state = state;
    this.stateError = error;
    const at = new Date().toISOString();
    this.writes = this.writes.then(() =>
      platformDb(this.db)
        .updateTable('app_settings')
        .set({ hub_tunnel_state: state, hub_tunnel_error: error, hub_tunnel_at: at })
        .where('id', '=', true)
        .execute()
        .then(() => undefined)
        .catch(() => undefined),
    );
    await this.writes;
  }
}
