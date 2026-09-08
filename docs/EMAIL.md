# Email communication module

One reusable path for every email the platform sends — invitations today,
workflow / approval / review notifications later. All mail is **queued** and sent
by the worker, and every message is logged.

## Flow

```
API (MailService.enqueue)
  ├─ INSERT platform.email_messages  (status 'queued', template + context)
  └─ BullMQ 'mail' queue  ──►  worker (handleMail)
                                 ├─ renderEmail(template, context)  → subject/html/text
                                 ├─ SMTP send  (nodemailer)
                                 └─ UPDATE email_messages  (status 'sent' | 'failed', attempts, error)
```

- **Enqueue side** — `apps/api/src/mail/mail.service.ts`. `enqueue()` writes the
  row and adds a `send` job (`attempts: 5`, exponential backoff from 15 s).
  `resend(id)` re-queues an existing row (used by "Resend invite").
- **Send side** — `apps/worker/src/mail/`:
  - `mailer.ts` — nodemailer transport from `SMTP_*`; `mailerConfigured` is
    `false` when `SMTP_HOST` is unset.
  - `layout.ts` — the branded, inline-CSS shell (palette from
    `apps/web/src/theme.ts`: header `#4657D2`, button `#5B5FC7`, wordmark,
    "please do not reply" footer). `renderHtml` + `renderText`.
  - `templates.ts` — `renderEmail(template, context)` switch; one function per
    template.
  - `apps/worker/src/main.ts` — the `mail` BullMQ `Worker`.

## `platform.email_messages`

The auditable comms log. Key columns: `to_email`, `template`, `context` (jsonb),
`subject` (filled on render), `status` (`queued` / `sent` / `failed` / `skipped`),
`error`, `attempts`, `related_type` + `related_id` (e.g. `user` + the user id),
`created_by`, `created_at`, `sent_at`.

## SMTP configuration

Set in the deploy `.env` (see `.env.example`). Works with any provider (a mail
relay, Microsoft 365 / Google SMTP, SES / SendGrid / Postmark SMTP, …):

```
SMTP_HOST=          # empty = delivery disabled (worker logs the message instead)
SMTP_PORT=587
SMTP_SECURE=false   # true only for implicit-TLS ports (usually 465)
SMTP_USER=
SMTP_PASS=
MAIL_FROM=no-reply@voxshift.io
MAIL_FROM_NAME=Teams Voice Migration Factory
```

**When `SMTP_HOST` is empty** the worker logs the full rendered message (subject +
text body, including the invitation's temporary password) to its container log
and marks the row `failed` with `error = 'SMTP not configured'`. Inviting still
works: the admin copies the temporary password from the Users screen (shown once)
and shares it securely. Add real SMTP values and click **Resend invite** to
deliver for real.

### Office 365

Production uses Microsoft 365 SMTP AUTH client submission:

```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false          # STARTTLS; the worker sets requireTLS
SMTP_USER=no-reply@voxshift.io
SMTP_PASS=<app password>
MAIL_FROM=no-reply@voxshift.io
```

Tenant-side prerequisites (one-time):
1. `no-reply@voxshift.io` is a mailbox with an Exchange Online licence (a shared
   mailbox needs a licence + a set password to authenticate).
2. **Authenticated SMTP** is enabled for it — M365 admin center → the user →
   Mail → *Manage email apps* → tick *Authenticated SMTP*, or
   `Set-CASMailbox no-reply@voxshift.io -SmtpClientAuthenticationDisabled $false`.
   The org-wide switch (`Get-TransportConfig`) must not be blocking it.
3. If that account has MFA / Security Defaults, `SMTP_PASS` must be an **app
   password** (basic-auth SMTP can't do interactive MFA).
4. SPF for `voxshift.io` includes `include:spf.protection.outlook.com`; enable
   DKIM for the domain in the Defender portal so invitations don't get filtered.

## Invitations & first sign-in

1. A super admin / project manager / engineer creates a user (Users admin). No
   password field — the system generates a one-time password
   (`apps/api/src/users/password.util.ts`), stores it hashed with
   `must_change_password = true`, and enqueues a `user_invitation` email. The
   temp password is also returned to the admin once.
2. The user signs in with the temp password. `AuthService.login` sees
   `must_change_password` and returns a limited **`pwreset`** token
   (`passwordResetRequired: true`) — no session yet.
3. The web app shows **Set your password** (`apps/web/src/pages/SetPassword.tsx`).
   `POST /auth/password/change` (only reachable with a `pwreset` token) clears the
   flag and returns an **`enrol`** token.
4. The user then goes through the normal **MFA QR enrolment** and lands in the app.

`Resend invite` (`POST /users/:id/resend-invitation`) issues a fresh temp
password, re-sets `must_change_password`, revokes any sessions, and re-sends —
also usable as an admin "reset & re-invite".

## Adding a new email

1. Add the name to `EMAIL_TEMPLATES` in `packages/shared/src/email.ts` and a
   `<Name>Context` interface.
2. Add a `case` in `renderEmail` (`apps/worker/src/mail/templates.ts`) that builds
   a `LayoutInput` and returns `renderHtml` / `renderText`.
3. Call `mailService.enqueue({ template, to, context, related, createdBy })` from
   the API where the event happens.
