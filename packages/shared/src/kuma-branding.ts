/*
 * The look of the Kuma status page Voxshift manages (device-inventory.ts, kumaSlugForTenant). The same text is kept in
 * deploy/kuma/voxshift-status-page.css for people who set Kuma up by hand; kuma-branding.test.ts keeps the two identical.
 */
export const KUMA_STATUS_PAGE_CSS = `/* Voxshift brand for Uptime Kuma status pages (Kuma 2.5.x: status page > Edit > Custom CSS).
   Palette: brand #4657D2, accent #5B5FC7, deep #354BC0, ink #242424, muted #616161, tint #EEEFFD, rule #E3E3EC, ground #F6F6FB.
   Status colours (up / down) are left as Kuma draws them: they carry meaning, not brand. */
body {
  background: #F6F6FB !important;
  color: #242424;
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif !important;
}
a { color: #4657D2; }
a:hover { color: #354BC0; }

/* header: logo tile + title */
h1.title-flex { color: #242424; font-weight: 600; letter-spacing: -0.015em; }
h1.title-flex .logo { height: 44px; width: 44px; border-radius: 10px; }
.description { color: #616161; }

/* surfaces */
.shadow-box {
  background: #FFFFFF;
  border: 1px solid #E3E3EC;
  border-radius: 7px;
  box-shadow: 0 1px 2px rgba(36, 36, 36, 0.06);
}
.overall-status { font-weight: 600; }

/* groups and rows */
h2.group-title { color: #354BC0; font-size: 1.05rem; font-weight: 600; letter-spacing: 0.01em; }
.monitor-list .item { border-bottom: 1px solid #E3E3EC; }
.monitor-list .item:last-child { border-bottom: 0; }
.monitor-list .item:hover { background: #EEEFFD; }
.item-name { color: #242424; font-weight: 500; }

/* buttons (edit mode) */
.btn-primary { background-color: #4657D2; border-color: #4657D2; }
.btn-primary:hover { background-color: #354BC0; border-color: #354BC0; }

/* footer */
footer { border-top: 1px solid #E3E3EC; padding-top: 16px; color: #616161; }
footer .custom-footer-text { color: #616161; text-align: center !important; }
footer .refresh-info, footer .refresh-info * { color: #616161; font-size: 0.85rem; }
`;

export { KUMA_STATUS_PAGE_LOGO_DATA_URL } from './kuma-logo';

/** The CSS starts with this line, which is how Voxshift knows the page's CSS is its own (and may be brought up to date) rather than something a person wrote. */
export const KUMA_STATUS_PAGE_CSS_MARKER = '/* Voxshift brand for Uptime Kuma status pages';

export const KUMA_STATUS_PAGE_DESCRIPTION = 'Live status of the Teams voice equipment at your sites. Checked from inside your network.';
export const KUMA_STATUS_PAGE_FOOTER = 'Voxshift \u00b7 Microsoft Teams voice, migrated and managed';
