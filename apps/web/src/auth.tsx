import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Me, Permission } from '@tvmf/shared';
import { can } from '@tvmf/shared';
import { api, auth as apiAuth, tryRefresh } from './api';

type Status = 'loading' | 'anonymous' | 'pwreset' | 'enrol' | 'authenticated';

interface AuthContextValue {
  status: Status;
  me: Me | null;
  activeTenantId: string | null;
  setActiveTenant: (id: string | null) => void;
  login: (
    email: string,
    password: string,
    totp?: string,
  ) => Promise<'ok' | 'enrol' | 'mfa' | 'pwreset'>;
  /** Set a new password on the forced first-sign-in reset, then move to enrol. */
  changePassword: (newPassword: string) => Promise<void>;
  /** Verify the first TOTP code, adopt the returned session, and finish sign-in. */
  confirmEnrol: (code: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (p: Permission) => boolean;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(
    () => localStorage.getItem('tvmf.tenant'),
  );

  const setActiveTenant = useCallback((id: string | null) => {
    setActiveTenantId(id);
    apiAuth.setActiveTenant(id);
    if (id) localStorage.setItem('tvmf.tenant', id);
    else localStorage.removeItem('tvmf.tenant');
  }, []);

  const loadMe = useCallback(async () => {
    const m = await api<Me>('/auth/me');
    setMe(m);
    setStatus('authenticated');
    if (!apiAuth.getActiveTenant() && m.tenants[0]) setActiveTenant(m.tenants[0].id);
  }, [setActiveTenant]);

  useEffect(() => {
    apiAuth.setActiveTenant(activeTenantId);
    apiAuth.onLost(() => {
      setMe(null);
      setStatus('anonymous');
    });
    (async () => {
      const t = await tryRefresh();
      if (!t) return setStatus('anonymous');
      try {
        await loadMe();
      } catch {
        setStatus('anonymous');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback<AuthContextValue['login']>(
    async (email, password, totp) => {
      const res = await api<
        | { passwordResetRequired: true; accessToken: string }
        | { enrolRequired: true; accessToken: string }
        | { accessToken: string; expiresIn: number }
      >('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, totp }) });
      apiAuth.setToken(res.accessToken);
      if ('passwordResetRequired' in res) {
        setStatus('pwreset');
        return 'pwreset';
      }
      if ('enrolRequired' in res) {
        setStatus('enrol');
        return 'enrol';
      }
      await loadMe();
      return 'ok';
    },
    [loadMe],
  );

  const changePassword = useCallback(
    async (newPassword: string) => {
      const res = await api<
        { enrolRequired: true; accessToken: string } | { accessToken: string; expiresIn: number }
      >('/auth/password/change', { method: 'POST', body: JSON.stringify({ newPassword }) });
      apiAuth.setToken(res.accessToken);
      if ('enrolRequired' in res) {
        setStatus('enrol');
        return;
      }
      await loadMe();
    },
    [loadMe],
  );

  const confirmEnrol = useCallback(
    async (code: string) => {
      // Adopt the full-session access token the server hands back on a
      // successful enrolment BEFORE calling /auth/me, otherwise the request
      // still carries the limited "enrol" token and 403s.
      const res = await api<{ accessToken: string; expiresIn: number }>('/auth/totp/confirm', {
        method: 'POST',
        body: JSON.stringify({ totp: code }),
      });
      apiAuth.setToken(res.accessToken);
      await loadMe();
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    apiAuth.setToken(null);
    setMe(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      activeTenantId,
      setActiveTenant,
      login,
      changePassword,
      confirmEnrol,
      logout,
      can: (p) => (me ? can(me.role, p) : false),
      refreshMe: loadMe,
    }),
    [status, me, activeTenantId, setActiveTenant, login, changePassword, confirmEnrol, logout, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
