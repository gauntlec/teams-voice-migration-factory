import { TENANT_HEADER } from '@tvmf/shared';

let accessToken: string | null = null;
let activeTenantId: string | null = null;
let onAuthLost: (() => void) | null = null;

export const auth = {
  setToken(t: string | null) {
    accessToken = t;
  },
  getToken() {
    return accessToken;
  },
  setActiveTenant(id: string | null) {
    activeTenantId = id;
  },
  getActiveTenant() {
    return activeTenantId;
  },
  onLost(cb: () => void) {
    onAuthLost = cb;
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

async function raw(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (activeTenantId) headers.set(TENANT_HEADER, activeTenantId);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(path.startsWith('/') ? path : `/${path}`, { ...init, headers, credentials: 'include' });
}

/** Attempt a silent refresh using the HttpOnly cookie. Returns a new access token or null. */
export async function tryRefresh(): Promise<string | null> {
  const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
  if (!res.ok) return null;
  const data = (await res.json()) as { accessToken: string };
  accessToken = data.accessToken;
  return data.accessToken;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await raw(`/api${path}`, init);
  if (res.status === 401 && accessToken) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await raw(`/api${path}`, init);
    } else {
      accessToken = null;
      onAuthLost?.();
    }
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg =
      (body && (body.message || body.error)) || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, Array.isArray(msg) ? msg.join(', ') : String(msg), body);
  }
  return body as T;
}
