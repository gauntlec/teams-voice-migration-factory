-- The Data Collection module is now called Site Data (it is the foundation for the site definition through to day-2 operations).
-- Feature requests and bug reports tag the part of the product they are about with that name, so existing tags follow it.
UPDATE platform.feature_requests SET area = 'Site Data' WHERE area = 'Data Collection';
UPDATE platform.bug_reports SET area = 'Site Data' WHERE area = 'Data Collection';
