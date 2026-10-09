-- Which MSP looks after a customer. Drives the MSP service-request queue: an
-- MSP's engineers and project managers see the requests of every customer
-- whose msp_id is their MSP. NULL = not assigned to an MSP (Super Admins only).
ALTER TABLE platform.tenants ADD COLUMN msp_id uuid REFERENCES platform.msps(id) ON DELETE SET NULL;
CREATE INDEX idx_tenants_msp_id ON platform.tenants (msp_id);
