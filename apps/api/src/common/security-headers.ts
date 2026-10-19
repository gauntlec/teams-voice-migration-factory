import helmet from 'helmet';

/**
 * The API's own security headers (helmet's defaults) with Strict-Transport-Security switched off. HSTS belongs to the one layer that
 * knows the address is https: the installer's Caddy front door (deploy/install/install.sh, --hsts-max-age) or the customer's own reverse
 * proxy. helmet's default (max-age 180 days plus includeSubDomains) would otherwise reach browsers on /api responses next to, and
 * different from, the front door's value, and includeSubDomains binds every other site on the customer's domain.
 */
export const apiSecurityHeaders = () => helmet({ strictTransportSecurity: false });
