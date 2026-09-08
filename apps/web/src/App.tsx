import { Spinner } from '@fluentui/react-components';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { AppShell } from './components/AppShell';
import { RequirePermission } from './components/RequirePermission';
import { Login } from './pages/Login';
import { EnrolTotp } from './pages/EnrolTotp';
import { Dashboard } from './pages/Dashboard';
import { DataCollection } from './pages/DataCollection';
import { SiteWorkspace } from './pages/SiteWorkspace';
import { Build } from './pages/Build';
import { Deployment } from './pages/Deployment';
import { Handover } from './pages/Handover';
import { AdminUsers } from './pages/admin/Users';
import { AdminTenants } from './pages/admin/Tenants';
import { AdminAudit } from './pages/admin/Audit';

export function App() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spinner label="Loading…" />
      </div>
    );
  }
  if (status === 'anonymous') return <Login />;
  if (status === 'enrol') return <EnrolTotp />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/data-collection" element={<DataCollection />} />
        <Route path="/data-collection/sites/:siteId" element={<SiteWorkspace />} />
        <Route path="/build" element={<Build />} />
        <Route path="/deployment" element={<Deployment />} />
        <Route path="/handover" element={<Handover />} />
        <Route
          path="/admin/users"
          element={
            <RequirePermission permission="user:read">
              <AdminUsers />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/tenants"
          element={
            <RequirePermission permission="tenant:create">
              <AdminTenants />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <RequirePermission permission="audit:read:platform">
              <AdminAudit />
            </RequirePermission>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
