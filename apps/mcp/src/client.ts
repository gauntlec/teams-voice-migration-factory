import { randomUUID } from 'node:crypto';

/** What the Voxshift agent API said when it refused or failed a call. */
export class VoxshiftError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `taken_over`, `stale`, `propose_instead`, `in_flight` ... where the API gives one. */
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** The Voxshift address, e.g. https://www.directrouting.online (no /api). */
  baseUrl: string;
  /** vxs_agent_... token from Administration -> Assistants. */
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

/** A thin client for `/api/agent/v1` (docs/AGENTS.md). One method per endpoint, nothing clever. */
export class AgentApiClient {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.root = `${opts.baseUrl.replace(/\/+$/, '')}/api/agent/v1`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const res = await this.fetchImpl(`${this.root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!res.ok) {
      const j = json as { message?: string | string[]; code?: string };
      const msg = Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? `${method} ${path} failed (${res.status})`);
      throw new VoxshiftError(msg, res.status, j.code, json);
    }
    return json as T;
  }

  /** A write: the same key does the thing once, so a retry is safe. A fresh key is made when none is given. */
  private write<T = unknown>(method: string, path: string, body: unknown, key?: string) {
    return this.request<T>(method, path, body, key ?? randomUUID());
  }

  private at = (tenantId: string, incidentId: string) => `/incidents/${tenantId}/${incidentId}`;

  listIncidents(q: { status?: string; assigned?: string; tenantId?: string; limit?: number }) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return this.request(`GET`, `/incidents${p.size ? `?${p}` : ''}`);
  }
  getIncident(t: string, i: string) {
    return this.request('GET', this.at(t, i));
  }
  events(after: number, limit?: number) {
    return this.request('GET', `/events?after=${after}${limit ? `&limit=${limit}` : ''}`);
  }
  claim(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/claim`, body, key);
  }
  heartbeat(t: string, i: string, body: Json) {
    return this.request('POST', `${this.at(t, i)}/claim/heartbeat`, body);
  }
  release(t: string, i: string) {
    return this.request('DELETE', `${this.at(t, i)}/claim`);
  }
  note(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/notes`, body, key);
  }
  status(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/status`, body, key);
  }
  priority(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/priority`, body, key);
  }
  linkItem(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/items`, body, key);
  }
  diagnostic(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/diagnostics`, body, key);
  }
  diagnostics(t: string, i: string) {
    return this.request('GET', `${this.at(t, i)}/diagnostics`);
  }
  propose(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/proposals`, body, key);
  }
  proposals(t: string, i: string) {
    return this.request('GET', `${this.at(t, i)}/proposals`);
  }
  proposalResult(t: string, i: string, proposalId: string, body: Json) {
    return this.request('POST', `${this.at(t, i)}/proposals/${proposalId}/result`, body);
  }
  handoff(t: string, i: string, body: Json, key?: string) {
    return this.write('POST', `${this.at(t, i)}/handoff`, body, key);
  }

  /* ------------------------------ service requests ------------------------------ */

  private sr = (tenantId: string, requestId: string) => `/service-requests/${tenantId}/${requestId}`;

  listRequests(q: { status?: string; assigned?: string; tenantId?: string; type?: string; automatable?: boolean; limit?: number }) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    return this.request('GET', `/service-requests${p.size ? `?${p}` : ''}`);
  }
  getRequest(t: string, r: string) {
    return this.request('GET', this.sr(t, r));
  }
  claimRequest(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/claim`, body, key);
  }
  heartbeatRequest(t: string, r: string, body: Json) {
    return this.request('POST', `${this.sr(t, r)}/claim/heartbeat`, body);
  }
  releaseRequest(t: string, r: string) {
    return this.request('DELETE', `${this.sr(t, r)}/claim`);
  }
  requestNote(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/notes`, body, key);
  }
  requestStatus(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/status`, body, key);
  }
  applyRequest(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/apply`, body, key);
  }
  requestWhatIf(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/what-if`, body, key);
  }
  deployRequest(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/deploy`, body, key);
  }
  proposeOnRequest(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/proposals`, body, key);
  }
  requestProposals(t: string, r: string) {
    return this.request('GET', `${this.sr(t, r)}/proposals`);
  }
  requestProposalResult(t: string, r: string, proposalId: string, body: Json) {
    return this.request('POST', `${this.sr(t, r)}/proposals/${proposalId}/result`, body);
  }
  handoffRequest(t: string, r: string, body: Json, key?: string) {
    return this.write('POST', `${this.sr(t, r)}/handoff`, body, key);
  }
}
