import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Badge,
  Button,
  Dropdown,
  Menu,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Text,
  Toaster,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  ClipboardTaskListLtr24Regular,
  DocumentBulletListMultiple24Regular,
  DocumentFolder24Regular,
  Board24Regular,
  CloudArrowUp24Regular,
  Home24Regular,
  People24Regular,
  BuildingMultiple24Regular,
  Location24Regular,
  Mail24Regular,
  History24Regular,
  Lightbulb24Regular,
  Bug24Regular,
  Search24Regular,
  TicketDiagonal24Regular,
  AlertUrgent24Regular,
  BotSparkle24Regular,
  TaskListSquareLtr24Regular,
  ShieldCheckmark24Regular,
  AlertOn24Regular,
  Navigation24Regular,
  Dismiss24Regular,
} from '@fluentui/react-icons';
import type { MaintenanceNoticeView, Permission } from '@tvmf/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { TOASTER_ID } from '../hooks/useNotify';
import { useThemeMode } from '../ThemeMode';
import { Wordmark } from './Logo';

const useStyles = makeStyles({
  root: { display: 'grid', gridTemplateRows: '48px 1fr', height: '100vh', backgroundColor: tokens.colorNeutralBackground2 },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('0', '16px'),
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  brand: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForegroundOnBrand },
  headerRight: { display: 'flex', alignItems: 'center', ...shorthands.gap('12px') },
  skip: {
    position: 'absolute',
    left: '8px',
    top: '-48px',
    zIndex: 1000,
    ...shorthands.padding('8px', '12px'),
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorBrandForegroundLink,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    boxShadow: tokens.shadow8,
    ':focus': { top: '8px' },
  },
  menuButton: { display: 'none', '@media (max-width: 900px)': { display: 'inline-flex' }, color: tokens.colorNeutralForegroundOnBrand },
  brandRow: { display: 'flex', alignItems: 'center', ...shorthands.gap('8px'), minWidth: 0 },
  hideSmall: { '@media (max-width: 900px)': { display: 'none' } },
  picker: { minWidth: '220px', '@media (max-width: 900px)': { minWidth: '140px', maxWidth: '45vw' } },
  scrim: {
    display: 'none',
    '@media (max-width: 900px)': { display: 'block', position: 'fixed', top: '48px', left: 0, right: 0, bottom: 0, zIndex: 20, backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  },
  body: { display: 'grid', gridTemplateColumns: '224px minmax(0, 1fr)', minHeight: 0, '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  nav: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.padding('8px', '0'),
    overflowY: 'auto',
    // Under 900px the nav is a drawer from the left, over the page, opened by the menu button.
    '@media (max-width: 900px)': {
      position: 'fixed',
      top: '48px',
      bottom: 0,
      left: 0,
      width: '272px',
      zIndex: 30,
      boxShadow: tokens.shadow28,
      transform: 'translateX(-100%)',
      visibility: 'hidden',
      transitionProperty: 'transform, visibility',
      transitionDuration: '200ms',
      transitionTimingFunction: 'ease-out',
    },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '1ms' },
  },
  navOpen: { '@media (max-width: 900px)': { transform: 'translateX(0)', visibility: 'visible' } },
  navSectionLabel: {
    ...shorthands.padding('12px', '16px', '4px'),
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    textTransform: 'uppercase',
    letterSpacing: '.04em',
  },
  // Sits between navSectionLabel's siblings within Administration - lighter
  // weight and no uppercase, so the section still reads as one "Administration"
  // area at a glance, just split into its actual purposes (tenancy vs.
  // observability vs. feedback) instead of one flat 8-item list.
  navGroupLabel: {
    ...shorthands.padding('10px', '16px', '2px'),
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('10px'),
    ...shorthands.padding('8px', '16px'),
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    fontSize: tokens.fontSizeBase300,
    ...shorthands.borderLeft('3px', 'solid', 'transparent'),
  },
  navItemActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    borderLeftColor: tokens.colorBrandStroke1,
    fontWeight: tokens.fontWeightSemibold,
  },
  content: { minWidth: 0, overflowY: 'auto', ...shorthands.padding('24px', '32px'), '@media (max-width: 900px)': { ...shorthands.padding('16px') } },
});

interface NavDef {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: Permission;
  /** Only shown when the active customer has Managed Services switched on. */
  requiresManagedServices?: boolean;
}

const MIGRATION: NavDef[] = [
  { to: '/', label: 'Dashboard', icon: <Home24Regular /> },
  { to: '/data-collection', label: 'Data Collection', icon: <ClipboardTaskListLtr24Regular />, permission: 'discovery:read' },
  { to: '/discovery', label: 'Discovery', icon: <Search24Regular />, permission: 'tenantdiscovery:read' },
  { to: '/build', label: 'Design & Build', icon: <Board24Regular />, permission: 'build:read' },
  { to: '/deployment', label: 'Deployment', icon: <CloudArrowUp24Regular />, permission: 'deployment:read' },
  { to: '/handover', label: 'Service Handover', icon: <DocumentBulletListMultiple24Regular />, permission: 'handover:read' },
  { to: '/files', label: 'Files', icon: <DocumentFolder24Regular />, permission: 'files:read' },
];

/** The managed service for the active customer. The whole section is hidden unless that customer has Managed Services switched on. */
const OPERATIONS: NavDef[] = [
  { to: '/incidents', label: 'Incidents', icon: <AlertUrgent24Regular />, permission: 'inc:read', requiresManagedServices: true },
  { to: '/service-requests', label: 'Service Requests', icon: <TicketDiagonal24Regular />, permission: 'sr:read', requiresManagedServices: true },
];

/** Cross-customer views for an MSP's own staff (and Super Admins). */
const MSP_ITEMS: NavDef[] = [
  { to: '/msp/incidents', label: 'Incident console', icon: <AlertOn24Regular />, permission: 'inc:msp' },
  { to: '/msp/service-requests', label: 'Service request admin', icon: <TaskListSquareLtr24Regular />, permission: 'sr:msp' },
];

/**
 * Split into sub-groups by purpose rather than one flat 8-item list - tenancy
 * management, platform observability and user feedback are different jobs
 * that happened to share one "Administration" label with no visual
 * separation beyond it.
 */
const ADMIN_GROUPS: { label: string; items: NavDef[] }[] = [
  {
    label: 'Tenancy',
    items: [
      { to: '/admin/users', label: 'Users', icon: <People24Regular />, permission: 'user:read' },
      { to: '/admin/tenants', label: 'Customers', icon: <BuildingMultiple24Regular />, permission: 'tenant:create' },
      { to: '/admin/msps', label: 'MSPs', icon: <BuildingMultiple24Regular />, permission: 'msp:read' },
      { to: '/admin/sites', label: 'Sites', icon: <Location24Regular />, permission: 'discovery:sites:manage' },
      { to: '/admin/agents', label: 'Assistants', icon: <BotSparkle24Regular />, permission: 'agent:manage' },
    ],
  },
  {
    label: 'Observability',
    items: [
      { to: '/admin/release-check', label: 'Release check', icon: <ShieldCheckmark24Regular />, permission: 'platform:operate' },
      { to: '/admin/email', label: 'Email log', icon: <Mail24Regular />, permission: 'audit:read:platform' },
      { to: '/admin/audit', label: 'Platform Audit', icon: <History24Regular />, permission: 'audit:read:platform' },
    ],
  },
  {
    label: 'Feedback',
    items: [
      { to: '/feature-requests', label: 'Feature requests', icon: <Lightbulb24Regular />, permission: 'feature:read' },
      { to: '/bug-reports', label: 'Bug reports', icon: <Bug24Regular />, permission: 'bug:read' },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const s = useStyles();
  const navigate = useNavigate();
  const { me, can, activeTenantId, setActiveTenant, logout } = useAuth();
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const { mode, setMode } = useThemeMode();

  // The drawer closes when you go somewhere, and on Escape.
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const tenants = me?.tenants ?? [];

  // Keep a valid customer selected whenever the user has any (covers first login,
  // a customer just created this session, and a stale/removed selection).
  useEffect(() => {
    if (tenants.length === 0) return;
    if (!activeTenantId || !tenants.some((t) => t.id === activeTenantId)) {
      setActiveTenant(tenants[0].id);
    }
  }, [tenants, activeTenantId, setActiveTenant]);

  // Maintenance notice banner - staff only (customers have no live sessions to lose).
  const maintenance = useQuery({
    queryKey: ['maintenance'],
    queryFn: () => api<MaintenanceNoticeView | null>('/platform/maintenance'),
    enabled: !!me && me.role !== 'CUSTOMER',
    refetchInterval: 60_000,
  });

  if (!me) return null;

  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? tenants[0];
  const visibleAdminGroups = ADMIN_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.permission || can(i.permission)),
  })).filter((g) => g.items.length > 0);
  // Staff (ENGINEER/PROJECT_MANAGER) see their own MSP's branding, not the
  // customer tenant's - see BrandTheme.tsx. Switching the customer dropdown
  // below must not change this.
  const logoUrl =
    me.role === 'CUSTOMER'
      ? activeTenant?.branding?.logo
        ? `/api/public/tenants/${activeTenant.id}/logo?v=${activeTenant.branding.logo.version}`
        : null
      : me.mspBranding?.logo
        ? `/api/public/msps/${me.mspId}/logo?v=${me.mspBranding.logo.version}`
        : null;

  const managedServices = tenants.find((t) => t.id === activeTenantId)?.managedServices ?? false;
  const navVisible = (i: NavDef) => (!i.permission || can(i.permission)) && (!i.requiresManagedServices || managedServices);
  // No Operations heading unless there is something under it (Managed Services on for this customer, and a permission to see it).
  const operationsVisible = OPERATIONS.some(navVisible);
  const renderNav = (items: NavDef[]) =>
    items
      .filter(navVisible)
      .map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.to === '/'}
          className={({ isActive }) => `${s.navItem} ${isActive ? s.navItemActive : ''}`}
        >
          {i.icon}
          <span>{i.label}</span>
        </NavLink>
      ));

  return (
    <div className={s.root}>
      <Toaster toasterId={TOASTER_ID} position="bottom-end" />
      <a href="#main" className={s.skip}>
        Skip to content
      </a>
      <header className={s.header}>
        <div className={s.brandRow}>
          <Button
            className={s.menuButton}
            appearance="transparent"
            icon={navOpen ? <Dismiss24Regular /> : <Navigation24Regular />}
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((o) => !o)}
          />
          <Wordmark tone="onDark" size={18} logoUrl={logoUrl} />
          {logoUrl && (
            <span className={s.hideSmall} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Text size={100} style={{ color: tokens.colorNeutralForegroundOnBrand, opacity: 0.7 }}>
                Powered by
              </Text>
              <Wordmark tone="onDark" size={11} />
            </span>
          )}
        </div>
        <div className={s.headerRight}>
          {activeTenant?.siteScoped && (
            <Text size={200} className={s.hideSmall} style={{ color: tokens.colorNeutralForegroundOnBrand, opacity: 0.85 }}>
              Site contact
            </Text>
          )}
          {activeTenant?.sandbox && (
            <Tooltip content="A test customer: its emails go to whoever triggered them, not to the real recipients." relationship="description">
              <Badge appearance="filled" color="warning" className={s.hideSmall}>
                Test customer
              </Badge>
            </Tooltip>
          )}
          {tenants.length > 0 ? (
            <Dropdown
              appearance="filled-lighter"
              size="small"
              placeholder="Select a customer"
              selectedOptions={activeTenant ? [activeTenant.id] : []}
              value={activeTenant?.name ?? ''}
              onOptionSelect={(_, d) => d.optionValue && setActiveTenant(d.optionValue)}
              className={s.picker}
              aria-label="Active customer"
            >
              {tenants.map((t) => (
                <Option key={t.id} value={t.id} text={t.name}>
                  {t.name}
                  {t.sandbox && (
                    <Badge appearance="tint" color="warning" size="small" style={{ marginLeft: 6 }}>
                      Test customer
                    </Badge>
                  )}
                </Option>
              ))}
            </Dropdown>
          ) : can('tenant:create') ? (
            <Button
              size="small"
              appearance="primary"
              icon={<BuildingMultiple24Regular />}
              onClick={() => navigate('/admin/tenants')}
            >
              Add a customer
            </Button>
          ) : (
            <Text size={200} style={{ color: tokens.colorNeutralForegroundOnBrand, opacity: 0.8 }}>
              No customers assigned
            </Text>
          )}
          <Menu checkedValues={{ theme: [mode] }} onCheckedValueChange={(_, d) => d.name === 'theme' && d.checkedItems[0] && setMode(d.checkedItems[0] as typeof mode)}>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content={`${me.displayName} · ${me.role}`} relationship="label">
                <Avatar name={me.displayName} size={28} color="colorful" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem disabled>{me.email}</MenuItem>
                <MenuItem disabled>Role: {me.role}</MenuItem>
                <MenuDivider />
                <MenuGroup>
                  <MenuGroupHeader>Appearance</MenuGroupHeader>
                  <MenuItemRadio name="theme" value="system">
                    Match my computer
                  </MenuItemRadio>
                  <MenuItemRadio name="theme" value="light">
                    Light
                  </MenuItemRadio>
                  <MenuItemRadio name="theme" value="dark">
                    Dark
                  </MenuItemRadio>
                </MenuGroup>
                <MenuDivider />
                <MenuItem onClick={() => void logout()}>Sign out</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </header>

      <div className={s.body}>
        {navOpen && <div className={s.scrim} onClick={() => setNavOpen(false)} aria-hidden />}
        <nav id="app-nav" aria-label="Main" className={navOpen ? `${s.nav} ${s.navOpen}` : s.nav}>
          <div className={s.navSectionLabel}>Migration</div>
          {renderNav(MIGRATION)}
          {operationsVisible && (
            <>
              <div className={s.navSectionLabel}>Operations</div>
              {renderNav(OPERATIONS)}
            </>
          )}
          {MSP_ITEMS.some((i) => !i.permission || can(i.permission)) && (
            <>
              <div className={s.navSectionLabel}>MSP</div>
              {renderNav(MSP_ITEMS)}
            </>
          )}
          {visibleAdminGroups.length > 0 && (
            <>
              <div className={s.navSectionLabel}>Administration</div>
              {visibleAdminGroups.map((g) => (
                <div key={g.label}>
                  <div className={s.navGroupLabel}>{g.label}</div>
                  {renderNav(g.items)}
                </div>
              ))}
            </>
          )}
        </nav>
        <main id="main" tabIndex={-1} className={s.content} style={{ outline: 'none' }}>
          {maintenance.data && (
            <MessageBar intent={maintenance.data.phase === 'freeze' ? 'warning' : 'info'} style={{ marginBottom: 16 }}>
              <MessageBarBody>
                <MessageBarTitle>
                  {maintenance.data.phase === 'freeze'
                    ? 'Platform update imminent - new deployments, discovery runs and sign-ins are paused'
                    : `Platform update scheduled for ${new Date(maintenance.data.startsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
                </MessageBarTitle>
                {maintenance.data.message}
              </MessageBarBody>
            </MessageBar>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
