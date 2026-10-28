# Making the source code private - plan

Version 1.0 (2026-10-28). Status: **prepared, not started.** Nothing in this document has been done yet; the repository is still public.

## 1. Why, and what "private" can and cannot do

The source code of Voxshift is readable by anyone while the repository is public. Making it private stops new readers. It does **not** take back
anything already copied: every commit in the history was public. A scan of the whole history found no private keys or tokens and GitHub
secret scanning has no alerts, so nothing needs rotating on that account (re-run the scan, section 6 step 1, immediately before the switch).

## 2. What the public repository is used for today

The repository is public on purpose. Four things rely on it and **would break the moment it goes private**:

| What | Where it points | Breaks because |
|---|---|---|
| First install: `curl .../releases/latest/download/install.sh` | `github.com/gauntlec/teams-voice-migration-factory/releases` | Release files of a private repository need a login |
| `voxshift self-update` on every installed host | the same releases, and `raw.githubusercontent.com/.../main/deploy/install/install.sh` as a fallback | same |
| Checking the installer's signature (cosign) | the signer identity names this repository's `build-images.yml` workflow | the identity changes if the signing moves |
| Reporting a vulnerability | `SECURITY.md` and `security.txt` (the email address `security@voxshift.io` is the second route and keeps working) | an outsider cannot open a private advisory on a private repository |

Two things do **not** need the repository to be public:

- **The container images** `ghcr.io/gauntlec/tvmf-api`, `tvmf-worker`, `tvmf-web`. Image visibility is set on the package, separately from the repository
  (checked: all three answer an anonymous pull today). The hub already shows the other direction works: a private package in a private repository.
  What must be confirmed before relying on it is that a *public* package stays public when its repository turns private (step 3 does this safely).
- Dockge on the test and www hosts, and the nightly image auto-update on customer hosts. They only pull images.

## 3. The design

Split in two. The product source becomes private; the small part customers must be able to reach stays public.

| | **Source repository** (private) | **Installer repository** (new, public) |
|---|---|---|
| Name | `gauntlec/teams-voice-migration-factory` (unchanged) | `gauntlec/voxshift-installer` |
| Holds | apps, packages, tests, docs, Dockge compose, the CI that builds the images | `install.sh`, `uninstall.sh`, the `check-*.sh` tests, customer install guides (`INSTALL-LINUX.md`, `INSTALL-LINUX-REFERENCE.md`), `SECURITY.md`, `security.txt` source |
| Workflows | `build-images` (builds and publishes the images, makes the `yyyy.mm.N` tag), CodeQL replacement, Dependabot | `installer-checks`, `release` (checksums + cosign signature + GitHub release) |
| Images | pushed to the same `ghcr.io/gauntlec/tvmf-*` packages, set **Public** | none |
| Visible to | you and whoever you add | everyone |

Why this shape: the installer is already public by nature (customers run it as root), so nothing secret moves out; and the installer is generated from
inline text, so it needs nothing else from the source tree (the `check-*.sh` scripts use stub tools and no other directory).

Decisions to make before building (recommendation in bold):

1. **Installer version numbers.** The installer repository releases on its own. **Keep the `yyyy.mm.N` form but count them in the installer repository** (so a
   host's "installer 2026.11.2" and "app 2026.11.14" are two different numbers; `voxshift version` shows both). The alternative, one shared number,
   needs a token that lets the private repository publish into the public one (a stored secret) and was rejected.
2. **Where security reports go.** **Open the installer repository's private advisory form and keep `security@voxshift.io`.** Reports about the product
   are reported there and handled privately. (`deploy/security/set-contact.sh` keeps the address in one place; the check script moves with it.)
3. **Account.** See section 4: this is the only decision with a running cost.

## 4. What going private costs and loses (read before agreeing)

- **GitHub Free cannot protect a private repository's branches.** GitHub answers "Upgrade to GitHub Pro or make this repository public" to any ruleset or
  branch protection on a private repository (this is what the private hub repository shows today; it has no protection). Going private on Free would
  therefore **remove** the lockdown applied on 2026-10-27 (pull request + checks required, no force-push). **GitHub Pro is about $4 a month** and restores
  it. A GitHub organisation on the Team plan (about $4 per person per month) does the same and is the better home if more people will ever get access; moving the
  repository into an organisation later keeps the history and redirects the old address.
- **CodeQL is free only on public repositories.** On a private one it needs GitHub Code Security (paid per active committer). Replacement: keep CodeQL
  running on the public installer repository (it is the part customers run as root) and add free scanning to the private repository (Semgrep or similar in
  an Action; `gitleaks` for secrets). Secret-scanning push protection is also paid on private repositories; the `gitleaks` check covers it.
  There are 6 CodeQL warnings open today (3 regular-expression slowdowns in `packages/shared/src/` device-status, opening-hours and coordinates, one
  file-path warning in `local-disk-storage.backend.ts`, one in a test); they are independent of this plan and can be cleared first.
- **Build minutes are no longer unlimited.** Public repositories build free; private ones draw on a monthly allowance (Free 2,000 minutes, Pro 3,000;
  extra minutes are about $0.008 each). Over the last 30 days there were 136 releases, 47 arm64 builds and 85 CodeQL runs. A single release uses about 13
  billed minutes (arm64 not measured), so expect **roughly 2,500 to 3,000 minutes a month** at the current pace: at or just over the allowance, an
  overage of well under $10. Arm64 runners work on private repositories (2 CPUs instead of 4, so a little slower). Check Settings > Billing after the first
  week.
- Dependabot, Dockge, the image scan, signed checksums and the hub are unaffected.

## 5. The part that can strand customers: installed hosts

Every installed host has an older `install.sh` that knows only the old repository address and the old signer identity. The moment the repository is
private, `voxshift self-update` on those hosts fails (they keep running; only the installer refresh fails, and image updates still work because the images
stay public). To avoid stranding anyone:

1. Publish a **bridge release from the old repository**, signed with the old identity, whose `install.sh` has the **new** address and the new signer
   identity. Hosts that self-update pick up the bridge and from then on follow the new repository.
2. Wait until the hub's instance list shows the hosts on the bridge installer (or accept the stragglers and tell them to download the installer again
   from the new address; their data is untouched).
3. Only then switch the old repository to private.

`check-selfupdate.sh` already simulates a self-update with fake downloads; extend it with a "bridge" case (old identity verifies the bridge, new identity
verifies the next release).

## 6. Order of work (each step can be undone until step 7)

| # | Step | Who | Can undo? |
|---|---|---|---|
| 1 | Re-scan the history for secrets (`gitleaks detect`); decide the account (Pro or organisation) and upgrade it | Craig (account), Claude (scan) | yes |
| 2 | Create the public `voxshift-installer` repository; move installer files, tests, customer install guides, `SECURITY.md`; add the `installer-checks` and `release` workflows; apply the same rules as today (pull request + checks, no force-push, locked tags, private advisories on) | Claude | yes |
| 3 | **Prove the images stay public:** make a throwaway private repository, publish a tiny image to a public package from it, pull it anonymously. Also confirm arm64 builds run in a private repository | Claude | yes (delete the test) |
| 4 | In the source repository: stop publishing installer files in the `release` job (keep the tag and the release note), add the free security scans, point `docs`, `SECURITY.md`, `security.txt`, the Dockge README and the version docs at the new addresses | Claude | yes |
| 5 | Publish the **bridge release** from the old repository (section 5) and deploy the new installer; test a fresh install and a self-update against a scratch host | Claude + Craig (a host to try on) | yes |
| 6 | Wait for installed hosts to move to the bridge (hub instance list) | Craig | yes |
| 7 | **Switch the source repository to private**; immediately check: a fresh install from the new address, `docker pull` anonymous, a push to `main` through a pull request builds and releases, the rules still show as active | Claude + Craig | yes (switch back to public; a private repository can be made public again, nothing is lost except that the window was private) |
| 8 | Update the memory notes and `docs/VERSIONING.md`; ask the hub repository's owner (you) whether `voxshift-hub` should also get protection (it has none, and Free cannot give it) | Claude | n/a |

## 7. Rollback

Until step 7 nothing customers use has changed. At step 7, if anything misbehaves, the repository is switched back to public (settings, one click) and the old
addresses work again within a minute. A bridge release keeps working in both cases because it contains the new address, which is always reachable.

## 8. What this plan does not do

- It does not hide anything already published (section 1).
- It does not change how the test and www instances are updated (Dockge, public images).
- It does not make the images private. That would need every customer host to log in to GHCR, and was rejected: the hub's private package already shows the
  cost (a manual `docker login` and `docker tag` on the host).
