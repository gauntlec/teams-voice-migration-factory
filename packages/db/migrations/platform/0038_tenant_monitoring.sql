-- Monitoring (Devices / Watch list / Alerts, docs/DEVICE-MONITORING.md) can be switched off for the whole installation (Administration > Platform settings >
-- Menus and features) and for one customer (Administration > Customers). On by default, so nothing changes for customers that already use it.
-- Off keeps everything the customer has set up; the pages, the API and the background reading, set-up and alert emails just stop.
ALTER TABLE platform.tenants ADD COLUMN monitoring_enabled boolean NOT NULL DEFAULT true;
