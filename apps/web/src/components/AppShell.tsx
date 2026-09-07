import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Avatar,
  Dropdown,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Option,
  Text,
  Tooltip,
  makeStyles,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  ClipboardTaskListLtr24Regular,
  DocumentBulletListMultiple24Regular,
  Board24Regular,
  CloudArrowUp24Regular,
  Home24Regular,
  People24Regular,
  BuildingMultiple24Regular,
  History24Regular,
} from '@fluentui/react-icons';
import type { Permission } from '@tvmf/shared';
import { useAuth } from '../auth';

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
  body: { display: 'grid', gridTemplateColumns: '224px 1fr', minHeight: 0 },
  nav: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.borderRight('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.padding('8px', '0'),
    overflowY: 'auto',
  },
  navSectionLabel: {
    ...shorthands.padding('12px', '16px', '4px'),
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    textTransform: 'uppercase',
    letterSpacing: '.04em',
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
  content: { minWidth: 0, overflowY: 'auto', ...shorthands.padding('24px', '32px') },
});

interface NavDef {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: Permission;
}

const MAIN: NavDef[] = [
  { to: '/', label: 'Dashboard', icon: <Home24Regular /> },
  { to: '/data-collection', label: 'Data Collection', icon: <ClipboardTaskListLtr24Regular />, permission: 'discovery:read' },
  { to: '/build', label: 'Design & Build', icon: <Board24Regular />, permission: 'build:read' },
  { to: '/deployment', label: 'Deployment', icon: <CloudArrowUp24Regular />, permission: 'deployment:read' },
  { to: '/handover', label: 'Service Handover', icon: <DocumentBulletListMultiple24Regular />, permission: 'handover:read' },
];

const ADMIN: NavDef[] = [
  { to: '/admin/users', label: 'Users', icon: <People24Regular />, permission: 'user:read' },
  { to: '/admin/tenants', label: 'Customers', icon: <BuildingMultiple24Regular />, permission: 'tenant:create' },
  { to: '/admin/audit', label: 'Platform Audit', icon: <History24Regular />, permission: 'audit:read:platform' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const s = useStyles();
  const { me, can, activeTenantId, setActiveTenant, logout } = useAuth();
  if (!me) return null;

  const tenants = me.tenants;
  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? tenants[0];
  const adminItems = ADMIN.filter((i) => !i.permission || can(i.permission));

  const renderNav = (items: NavDef[]) =>
    items
      .filter((i) => !i.permission || can(i.permission))
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
      <header className={s.header}>
        <Text className={s.brand} size={400}>
          Teams Voice Migration Factory
        </Text>
        <div className={s.headerRight}>
          {tenants.length > 0 && (
            <Dropdown
              appearance="filled-lighter"
              size="small"
              selectedOptions={activeTenant ? [activeTenant.id] : []}
              value={activeTenant?.name ?? 'No customer'}
              onOptionSelect={(_, d) => d.optionValue && setActiveTenant(d.optionValue)}
              style={{ minWidth: '200px' }}
            >
              {tenants.map((t) => (
                <Option key={t.id} value={t.id} text={t.name}>
                  {t.name}
                </Option>
              ))}
            </Dropdown>
          )}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content={`${me.displayName} · ${me.role}`} relationship="label">
                <Avatar name={me.displayName} size={28} color="colorful" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem disabled>{me.email}</MenuItem>
                <MenuItem disabled>Role: {me.role}</MenuItem>
                <MenuItem onClick={() => void logout()}>Sign out</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </header>

      <div className={s.body}>
        <nav className={s.nav}>
          <div className={s.navSectionLabel}>Migration</div>
          {renderNav(MAIN)}
          {adminItems.length > 0 && (
            <>
              <div className={s.navSectionLabel}>Administration</div>
              {renderNav(ADMIN)}
            </>
          )}
        </nav>
        <main className={s.content}>{children}</main>
      </div>
    </div>
  );
}
