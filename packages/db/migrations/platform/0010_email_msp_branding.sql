-- Threads MSP branding into outbound email the same way tenant_id already
-- does (0008_tenant_branding.sql) - invitation/reset emails to MSP staff
-- (ENGINEER/PROJECT_MANAGER) should render that MSP's branding, not always
-- default Voxshift, same as a customer tenant's own branding already does
-- for its tenant-scoped emails.
ALTER TABLE platform.email_messages ADD COLUMN msp_id uuid REFERENCES platform.msps(id) ON DELETE SET NULL;
CREATE INDEX idx_email_messages_msp_id ON platform.email_messages(msp_id);
