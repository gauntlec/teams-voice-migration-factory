# Working on this repository

These rules apply to every session, on every machine. Read [README.md](README.md) and the `docs/` folder before
changing anything: the docs are the contract.

## Who we're working with

- The people who own this project are not programmers. The code is written and maintained with AI help, so every
  decision should be one an AI can keep maintaining.
- Write in plain English: in the app's own words, in docs, in commit messages, PR descriptions and replies. Name
  things the way a person using the app would, not the way the code is built. Short sentences, no jargon where an
  everyday word will do.

## Never without the owner's word

- **Never merge a pull request** unless the owner has said so for that PR. Opening a PR is fine; merging is theirs.
- Never push to `main` directly. Every change goes on its own branch and through a PR.
- Never type, store or handle passwords, keys or tokens. The owner types sign-in and SSH passwords themselves.
- Never change system or security settings, and never deploy, without being asked.
- Never `--delete-branch` a PR that another PR is stacked on: GitHub closes the stacked one. Retarget it first.

## This repository is public

Nothing that identifies a customer goes into it: not in code, comments, test data, docs, commit messages, branch
names, PR titles or PR descriptions.

- No customer or company names, people's names, email addresses, UPNs, tenant names or phone numbers from a real
  customer.
- No internal host names or IP addresses of our servers.
- Use placeholders: `contoso.test`, `fabrikam.test`, "Alex Example", `+44 20 7946 0xxx`, "a US site".
- Check before every commit: `git diff --cached` for anything that looks like the above.

## Tools

- **npm only**, with `package-lock.json`. Install with `npm ci`. Never pnpm or yarn, and don't hand-edit the lock
  file.
- Don't run prettier or reformat files you aren't changing: keep diffs to what the change needs.
- Node 26, as CI and the images use (`package.json` asks for 24 or later).

## Before opening a PR

1. Typecheck everything. Vitest doesn't check types, and CI fails on a type error:
   ```bash
   npm run typecheck --workspaces --if-present
   ```
2. Run the tests the change touches, and all of them for anything shared:
   ```bash
   cd packages/shared && npx vitest run src
   cd apps/api && npx vitest run
   cd apps/web && npm test
   cd tests/db && npx vitest run
   ```
   The database tests start their own Postgres; run them as a normal user, not root.
3. If types from `@tvmf/shared` or `@tvmf/db` look out of date, rebuild them: `npx tsc -p tsconfig.json` in
   `packages/shared` and `packages/db`.
4. Add or update tests for what changed, and update the docs the change affects (`docs/DATA-MODEL.md` for a new
   column, the feature's own plan in `docs/` for its build log).
5. End commit messages and PR descriptions with the attribution lines the session gives you.

## Conventions

- Migrations: `packages/db/migrations/platform/NNNN_name.sql` for the platform schema and
  `packages/db/migrations/tenant/NNNN_name.sql` for each customer's schema (`{{SCHEMA}}` is replaced). Take the next
  number; never edit a migration that has shipped.
- Documents carry a `major.minor` version: a minor bump for small changes, major for a rewrite.
- The app's web address is `https://www.voxshift.io`. Don't use any other domain in code or docs.
- A feature that takes several steps gets a plan in `docs/` first (what, why, build order, questions), agreed with
  the owner before building, with a build log as steps ship.
- When a change ships and has been checked live, its card on the Feature requests or Bug reports board moves to
  Deployed with a short note saying what changed and in which release.
