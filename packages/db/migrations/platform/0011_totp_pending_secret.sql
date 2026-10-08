-- Re-enrolling MFA used to overwrite the confirmed secret straight away, so an
-- abandoned re-enrol left the user with a secret they never saw (login checks
-- secret_enc). The replacement now waits here until it is confirmed, and only
-- then becomes secret_enc.
ALTER TABLE platform.totp_secrets ADD COLUMN pending_secret_enc text;
