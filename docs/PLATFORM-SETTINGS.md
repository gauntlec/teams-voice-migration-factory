# Platform settings

**Administration > Platform settings** (Super Admin) holds the settings that apply to the whole installation. Everything here is stored in the database and takes effect without a restart.

| Card | What it does | More |
|---|---|---|
| Email on/off | One switch that stops all email being generated or sent | [EMAIL.md](EMAIL.md#the-master-switch) |
| **Menus and features** | Switch optional areas off for this installation (below) | this page |
| **Single sign-on** | Let people sign in with the Voxshift Hub or their own Entra ID / Okta / Google Workspace: providers, the highest role each can give, test sign-in, session length (own page: Platform settings > Single sign-on) | [SSO.md](SSO.md) |
| Voxshift hub | Connect to a Voxshift Hub: be listed there, let the hub's staff open this installation, send mail through the hub | [HUB-CONNECTION.md](HUB-CONNECTION.md) |
| How email is sent | Own mail server, the hub's mail service, or nothing; with a test email | [EMAIL.md](EMAIL.md#where-email-is-set-up) |
| Web address | The address people (and emails, and assistants) use to reach this installation | [BASE-URL.md](BASE-URL.md) |

## Menus and features

Some areas are not wanted everywhere: a customer's own installation does not need the bug and feature boards (those are for the people building Voxshift) or the MSP console.
Each can be switched **off** here (everything is on by default, so nothing changes until you switch something off):

| Area | Menus it removes | API it switches off |
|---|---|---|
| Feature requests | Feature requests | `/api/feature-requests` |
| Bug reports | Bug reports | `/api/bug-reports` |
| MSP features | Incident console, Service request admin, MSPs (and the MSP column on Customers and MSP fields on Users) | `/api/msps`, `/api/msp/incidents`, `/api/msp/service-requests` |

What "off" means:

- The **menu entries disappear** straight away for everyone, and their pages are no longer reachable.
- The **API answers "not found"** for those areas, as if they did not exist, so nothing can reach them by another route.
- **Nothing is deleted.** Switch the area back on and everything is as it was, including existing bug reports and requests.
- It applies to the whole installation, for every customer and every user, including Super Admins.

### How it works (for maintainers)

- Stored in `platform.app_settings.disabled_features` (a list of area keys; empty = all on; migration `0030_disabled_features.sql`).
- The areas are defined in `packages/shared/src/platform-features.ts` (`PLATFORM_FEATURES`, with the permissions that belong to each in `FEATURE_PERMISSIONS`).
- The API marks each optional controller with `@RequireFeature('<key>')`; a global `FeatureGuard` (`apps/api/src/common/feature.guard.ts`) answers 404 while the area is off.
- `GET /api/auth/me` returns `disabledFeatures`. The web app's `can(permission)` treats the permissions of a switched-off area as not granted, so every menu entry, route and field gated by them disappears together.
- To make another area switchable: add its key and permissions in `platform-features.ts`, mark its controllers with `@RequireFeature`, and (if it has fields outside its own pages) check `featureOn('<key>')` there.
