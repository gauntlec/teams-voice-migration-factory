-- Managed Services: a Super Admin switches this on per customer to let them raise
-- service requests (see docs/SERVICE-REQUESTS.md). Off by default.
ALTER TABLE platform.tenants ADD COLUMN managed_services_enabled boolean NOT NULL DEFAULT false;
