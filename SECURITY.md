# Security policy

Thank you for helping keep Voxshift and its users safe. This page says how to tell us about a security problem and what happens next.
(How the product protects data is described separately in [docs/SECURITY.md](docs/SECURITY.md).)

## How to report a vulnerability

Please report it **privately**. Do not open a public issue, and do not post details anywhere public until we have fixed it.

1. **GitHub private report (preferred):** [report a vulnerability on this repository](https://github.com/gauntlec/teams-voice-migration-factory/security/advisories/new).
   Only the repository's maintainers can see it.
2. **Email:** <!--SECURITY_CONTACT_EMAIL-->security@voxshift.io<!--/SECURITY_CONTACT_EMAIL-->

The same details are published in machine-readable form at <https://www.voxshift.io/.well-known/security.txt>.

## What to include

- What you found and where: the page, the request, the file or the command.
- The steps to repeat it, as exactly as you can (a short list is ideal), and what you expected to happen.
- What an attacker could do with it (what data, which customers, how much effort).
- Which Voxshift you tested: the hosted service at https://www.voxshift.io, or your own installation, and its release number (Administration >
  Platform settings, or `/version.json` on the web address).
- How to reach you, and whether you want to be named in the credit.

Please do not include real personal data, passwords or customer information in the report. If you came across such data, tell us what kind and where,
but do not keep or share it.

## What we do

- We **acknowledge your report within 3 working days**.
- We look into it, tell you whether we agree it is a vulnerability and how serious we think it is, and keep you informed while we work on it.
- We fix it in the **newest release**. We do not back-port fixes to older releases: the supported version is always the newest one, the hosted
  service runs it, and an installation gets it with `voxshift update` (or automatically, if automatic updates are on).
- We tell you when the fix is released. We are happy to agree a date for publishing the details together; please give us a reasonable time to fix
  the problem and for installations to update before you publish.
- We **credit you** in the release notes or the advisory if you want that (tell us the name to use), or keep you anonymous if you prefer.
- We do not run a paid bug bounty at the moment.

## What is covered

- The code in this repository: the web app, the API, the worker, the database packages and the Linux installer (`deploy/install`).
- The container images published as `ghcr.io/gauntlec/tvmf-api`, `tvmf-worker` and `tvmf-web`.
- The hosted service at https://www.voxshift.io.
- The Voxshift Hub service at https://hub.voxshift.io (its code is not in this repository, so report it by email).

Problems of interest include: seeing or changing another customer's data, getting in without signing in or with fewer rights than needed,
running commands or code on our servers, leaking secrets or keys, and weaknesses in the installer or the release files.

## What is not covered

- Other people's installations and networks. Test only against your own installation or your own account, never against another customer's data or
  tenant. Settings a customer chose for their own installation (for example plain `http` with `--tls none`) are theirs to decide.
- Microsoft 365, Microsoft Teams, GitHub, OpenStreetMap, Let's Encrypt and other services we use: please report those to their owners.
- Denial-of-service and load testing, spam, social engineering or phishing of staff or customers, and physical attacks.
- Reports with no demonstrated impact, such as raw scanner output, a missing header with no way to use it, or software version banners.
- Attacks that already need full control of the user's device, or administrator (root) access to the host.
- Limits that [docs/SECURITY.md](docs/SECURITY.md) already lists as known; but tell us if you find a way to make one of them worse.

## Safe harbour

If you act in good faith and follow this policy (you only use your own accounts and installations, you do not read, change or keep other people's
data, you do not disrupt the service, you report to us first and you give us time to fix it), we will not take legal action against you for your
research and we will not ask anyone else to. This is a promise about what we will do; we cannot speak for other people, such as a customer whose
data is involved. If you are unsure whether something is allowed, ask us first.
