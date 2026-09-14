-- White-label branding per customer, and which tenant an outbound email
-- belongs to (so the worker can look up that tenant's branding when
-- rendering). branding is null until an admin sets it - null means "use
-- default Voxshift branding" everywhere (web theme, Logo component, email
-- layout).
ALTER TABLE platform.tenants ADD COLUMN branding jsonb;
ALTER TABLE platform.email_messages ADD COLUMN tenant_id uuid REFERENCES platform.tenants(id) ON DELETE SET NULL;
CREATE INDEX idx_email_messages_tenant_id ON platform.email_messages(tenant_id);
