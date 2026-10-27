import { io, type Socket } from 'socket.io-client';
import type { KumaApi, KumaMonitorInfo } from '@tvmf/db';
import { KUMA_STATUS_PAGE_CSS, KUMA_STATUS_PAGE_DESCRIPTION, KUMA_STATUS_PAGE_FOOTER } from '@tvmf/shared';

/**
 * The only code that speaks Uptime Kuma's Socket.IO API (the one its own screen uses; Kuma documents no other way to make monitors). Written against
 * Kuma 2.5.7, the version Voxshift pins, and checked against a real one by tests/db/src/devices/kuma-contract.db.test.ts (set KUMA_CONTRACT_URL).
 * A Kuma upgrade must pass that test before the pin moves. Reading status (device-status.ts) does not depend on any of this.
 */

const CALL_TIMEOUT_MS = 15_000;

interface Reply { ok?: boolean; msg?: string; [k: string]: unknown }

export class KumaClient implements KumaApi {
  private list = new Map<number, KumaMonitorInfo>();
  private gotList: Promise<void>;
  private resolveGotList!: () => void;
  private constructor(private readonly socket: Socket) {
    this.gotList = new Promise((r) => { this.resolveGotList = r; });
    // Kuma sends the whole monitor list once, right after sign-in, and every change to it afterwards: keep up, so a second sync on this connection sees the first.
    socket.on('monitorList', (list: Record<string, KumaMonitorInfo>) => { this.list = new Map(Object.values(list ?? {}).map((m) => [m.id, m])); this.resolveGotList(); });
    socket.on('updateMonitorIntoList', (list: Record<string, KumaMonitorInfo>) => { for (const m of Object.values(list ?? {})) this.list.set(m.id, m); });
    socket.on('deleteMonitorFromList', (id: number) => { this.list.delete(id); });
  }

  /** Why Kuma could not be reached, said as plainly as can be found out. A Kuma with an empty data folder waits at a "choose your database" screen and serves no Socket.IO API. */
  private static async explain(url: string, fallback: string): Promise<Error> {
    try {
      const r = (await fetch(`${url}/api/entry-page`, { signal: AbortSignal.timeout(4000) }).then((x) => x.json())) as { type?: string };
      if (r?.type === 'setup-database') {
        return new Error('Kuma is waiting for you to choose its database, so it cannot be set up yet. Start Kuma with UPTIME_KUMA_DB_TYPE=sqlite (Voxshift\'s compose files and installer do) or finish that screen in Kuma.');
      }
    } catch {
      // not Kuma, or not reachable at all: the original reason stands
    }
    return new Error(fallback);
  }

  static async connect(url: string): Promise<KumaClient> {
    const socket = io(url, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Kuma did not answer. Is it running, and is the address right?')), 12_000);
        socket.once('connect', () => { clearTimeout(t); resolve(); });
        socket.once('connect_error', (e) => { clearTimeout(t); reject(new Error(`Cannot reach Kuma at ${url}: ${e.message}`)); });
      });
    } catch (e) {
      socket.close();
      throw await KumaClient.explain(url, (e as Error).message);
    }
    const client = new KumaClient(socket);
    await client.waitUntilReady();
    return client;
  }

  /** Kuma starts listening for requests a moment after it accepts the connection, so ask something cheap until it answers. */
  private async waitUntilReady(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const answered = await Promise.race([new Promise<boolean>((r) => this.socket.emit('needSetup', () => r(true))), new Promise<boolean>((r) => setTimeout(() => r(false), 500))]);
      if (answered) return;
    }
    throw new Error('Kuma accepted the connection but did not answer. Is it still starting?');
  }

  close() { this.socket.close(); }

  private call<T extends Reply = Reply>(event: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Kuma did not answer "${event}" in time.`)), CALL_TIMEOUT_MS);
      this.socket.emit(event, ...args, (r: T) => { clearTimeout(t); resolve(r); });
    });
  }
  private async need(event: string, ...args: unknown[]): Promise<Reply> {
    const r = await this.call(event, ...args);
    if (!r?.ok) throw new Error(String(r?.msg ?? `Kuma refused "${event}"`));
    return r;
  }

  async needSetup(): Promise<boolean> { return new Promise((r) => this.socket.emit('needSetup', (v: boolean) => r(!!v))); }

  /** Makes Kuma's administrator (only possible while Kuma has none). */
  async setup(username: string, password: string): Promise<void> { await this.need('setup', username, password); }

  /** Signs in. Throws a plain message when Kuma does not accept the sign-in (including when it wants a 2FA code, which Voxshift cannot give). */
  async login(username: string, password: string): Promise<void> {
    const r = await this.call('login', { username, password, token: '' });
    if (r?.tokenRequired) throw new Error('Kuma asks for a two-factor code for this administrator. Voxshift cannot give one: use a Kuma administrator without 2FA for it.');
    if (!r?.ok) throw new Error('Kuma did not accept the administrator sign-in. Enter the right one under Device status > Settings.');
  }

  async listMonitors(): Promise<Map<number, KumaMonitorInfo>> {
    await Promise.race([this.gotList, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Kuma did not send its monitor list.')), CALL_TIMEOUT_MS))]);
    // Changes arrive as events just after the reply to the call that made them: give the last one a moment.
    await new Promise((r) => setTimeout(r, 150));
    return new Map(this.list);
  }

  async ensureTag(name: string, color: string): Promise<number> {
    const r = await this.need('getTags');
    const found = (r.tags as Array<{ id: number; name: string }> | undefined)?.find((t) => t.name === name);
    if (found) return found.id;
    const made = await this.need('addTag', { name, color });
    return (made.tag as { id: number }).id;
  }

  async addMonitor(payload: Record<string, unknown>): Promise<number> {
    const r = await this.need('add', payload);
    return r.monitorID as number;
  }

  async editMonitor(current: KumaMonitorInfo, fields: Record<string, unknown>): Promise<void> {
    await this.need('editMonitor', { ...current, ...fields });
  }

  async deleteMonitor(id: number): Promise<void> { await this.need('deleteMonitor', id, false); }
  async addMonitorTag(tagId: number, monitorId: number, value: string): Promise<void> { await this.need('addMonitorTag', tagId, monitorId, value); }
  async deleteMonitorTag(tagId: number, monitorId: number, value: string): Promise<void> { await this.need('deleteMonitorTag', tagId, monitorId, value); }

  async saveStatusPage(slug: string, title: string, groups: Array<{ name: string; monitorIds: number[] }>): Promise<void> {
    let got = await this.call('getStatusPage', slug);
    if (!got?.ok) {
      await this.need('addStatusPage', title, slug);
      got = await this.need('getStatusPage', slug);
    }
    const cfg = got.config as Record<string, unknown>;
    // Voxshift sets what it needs (the title, tags shown, no "powered by") and the look once; a page someone has already styled keeps its CSS, description and footer.
    const config = {
      ...cfg,
      title,
      showTags: true,
      showPoweredBy: false,
      theme: 'light',
      domainNameList: (cfg.domainNameList as unknown[] | undefined) ?? [],
      description: cfg.description || KUMA_STATUS_PAGE_DESCRIPTION,
      footerText: cfg.footerText || KUMA_STATUS_PAGE_FOOTER,
      customCSS: cfg.customCSS || KUMA_STATUS_PAGE_CSS,
    };
    await this.need('saveStatusPage', slug, config, (cfg.icon as string | undefined) || '/icon.svg', groups.map((g) => ({ name: g.name, monitorList: g.monitorIds.map((id) => ({ id })) })));
  }
}
