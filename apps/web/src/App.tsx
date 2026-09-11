import { Spinner } from '@fluentui/react-components';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { AppShell } from './components/AppShell';
import { RequirePermission } from './components/RequirePermission';
import { Login } from './pages/Login';
import { SetPassword } from './pages/SetPassword';
import { EnrolTotp } from './pages/EnrolTotp';
import { Dashboard } from './pages/Dashboard';
import { DataCollection } from './pages/DataCollection';
import { DataCollectionPolicies } from './pages/DataCollectionPolicies';
import { SiteWorkspace } from './pages/SiteWorkspace';
import { Build } from './pages/Build';
import { BuildSiteWorkspace } from './pages/BuildSiteWorkspace';
import { Deployment } from './pages/Deployment';
import { Handover } from './pages/Handover';
import { AdminUsers } from './pages/admin/Users';
import { AdminTenants } from './pages/admin/Tenants';
import { AdminSites } from './pages/admin/Sites';
import { AdminEmailLog } from './pages/admin/EmailLog';
import { AdminAudit } from './pages/admin/Audit';
import { FeatureRequests } from './pages/FeatureRequests';
import { Discovery } from './pages/Discovery';

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
  if (status === 'pwreset') return <SetPassword />;
  if (status === 'enrol') return <EnrolTotp />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/data-collection" element={<DataCollection />} />
        <Route path="/data-collection/policies" element={<DataCollectionPolicies />} />
        <Route path="/data-collection/sites/:siteId" element={<SiteWorkspace />} />
        <Route
          path="/discovery"
          element={
            <RequirePermission permission="tenantdiscovery:read">
              <Discovery />
            </RequirePermission>
          }
        />
        <Route
          path="/build"
          element={
            <RequirePermission permission="build:read">
              <Build />
            </RequirePermission>
          }
        />
        <Route
          path="/build/sites/:siteId"
          element={
            <RequirePermission permission="build:read">
              <BuildSiteWorkspace />
            </RequirePermission>
          }
        />
        <Route
          path="/deployment"
          element={
            <RequirePermission permission="deployment:read">
              <Deployment />
            </RequirePermission>
          }
        />
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
          path="/admin/sites"
          element={
            <RequirePermission permission="discovery:sites:manage">
              <AdminSites />
            </RequirePermission>
          }
        />
        <Route
          path="/admin/email"
          element={
            <RequirePermission permission="audit:read:platform">
              <AdminEmailLog />
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
        <Route
          path="/feature-requests"
          element={
            <RequirePermission permission="feature:read">
              <FeatureRequests />
            </RequirePermission>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
