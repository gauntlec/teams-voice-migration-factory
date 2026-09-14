import { useMemo, type ReactNode } from 'react';
import { FluentProvider } from '@fluentui/react-components';
import { useAuth } from './auth';
import { buildTenantTheme } from './theme';

/**
 * Re-themes the authenticated app to the active tenant's branding, when set.
 * Renders a nested `FluentProvider` (Fluent supports this - it restyles only
 * its own subtree) so the outer default Voxshift theme in main.tsx keeps
 * covering the login screen, which always renders before a tenant is known
 * (AuthProvider hasn't resolved `me` yet). Switching tenants via AppShell's
 * customer dropdown just flips `activeTenantId` - since branding for every
 * tenant a user belongs to is already on `me.tenants` from one `/auth/me`
 * call, this re-renders the theme with no extra network request.
 *
 * Which branding applies depends on role: a CUSTOMER sees their tenant's
 * branding (unchanged). Staff (ENGINEER/PROJECT_MANAGER) see their own
 * MSP's branding instead, resolved server-side onto `me.mspBranding` -
 * switching customer tenants must NOT change what staff see, since the
 * branding is about who they work for, not which customer they're looking
 * at. SUPER_ADMIN always gets `me.mspBranding === null`, i.e. default.
 */
export function BrandThemeProvider({ children }: { children: ReactNode }) {
  const { status, me, activeTenantId } = useAuth();
  const accentColor =
    status === 'authenticated' && me
      ? me.role === 'CUSTOMER'
        ? me.tenants.find((t) => t.id === activeTenantId)?.branding?.accentColor
        : me.mspBranding?.accentColor
      : undefined;

  const theme = useMemo(() => (accentColor ? buildTenantTheme(accentColor) : undefined), [accentColor]);

  if (!theme) return <>{children}</>;
  return (
    <FluentProvider theme={theme} style={{ minHeight: '100vh' }}>
      {children}
    </FluentProvider>
  );
}
