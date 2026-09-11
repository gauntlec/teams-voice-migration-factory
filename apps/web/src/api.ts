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

/**
 * Download a binary response (a file's `.../download` route) and save it
 * with the browser's normal download UI. A plain `<a href>` can't do this -
 * every API route needs the bearer token in an Authorization header
 * (auth.getToken(), see raw() above), which a browser-navigated link never
 * sends - so this fetches like api() does but as a Blob, then triggers the
 * save via a synthetic anchor with a client-side object URL.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  let res = await raw(`/api${path}`, {});
  if (res.status === 401 && accessToken) {
    const refreshed = await tryRefresh();
    if (refreshed) res = await raw(`/api${path}`, {});
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(await res.text());
      msg = body?.message || body?.error || msg;
    } catch {
      /* not JSON - keep the status text */
    }
    throw new ApiError(res.status, Array.isArray(msg) ? msg.join(', ') : String(msg));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
