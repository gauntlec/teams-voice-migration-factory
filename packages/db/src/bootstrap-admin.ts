import * as argon2 from 'argon2';
import type { Pool } from 'pg';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export interface BootstrapAdminInput {
  email: string;
  /** Needed to create the account, or to reset it; not needed when the account already exists and `reset` is false. */
  password: string;
  /** Put the account back: new password, Super Admin role, active, unlocked. Off by default. */
  reset: boolean;
}

export type BootstrapAdminResult = { action: 'created' | 'reset' | 'unchanged'; id: string };

/**
 * The first Super Admin (BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD). Runs on every API start, so it must not undo
 * what people have done since: the password is set ONLY when the account is created. After that the account is left
 * alone (a changed password, role or status stays), unless `reset` is true - the deliberate recovery path
 * (BOOTSTRAP_ADMIN_RESET=true, or `voxshift reset-admin` on an installed host).
 */
export async function seedBootstrapAdmin(pool: Pick<Pool, 'query'>, input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
  const email = input.email.toLowerCase().trim();
  if (!email) throw new Error('Set BOOTSTRAP_ADMIN_EMAIL');

  const existing = await pool.query<{ id: string }>('SELECT id FROM platform.users WHERE email = $1', [email]);
  if (existing.rows[0] && !input.reset) return { action: 'unchanged', id: existing.rows[0].id };

  if (!input.password) throw new Error(existing.rows[0] ? 'Set BOOTSTRAP_ADMIN_PASSWORD to reset the admin' : 'Set BOOTSTRAP_ADMIN_PASSWORD (needed to create the first admin)');
  if (input.password.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  const hash = await argon2.hash(input.password, ARGON);

  if (!existing.rows[0]) {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO platform.users (email, password_hash, display_name, role, break_glass)
       VALUES ($1, $2, 'Platform Admin', 'SUPER_ADMIN', true)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, hash],
    );
    // Lost a race with another starting process: it created the account, which is all that was wanted.
    if (!created.rows[0]) {
      const again = await pool.query<{ id: string }>('SELECT id FROM platform.users WHERE email = $1', [email]);
      return { action: 'unchanged', id: again.rows[0]!.id };
    }
    return { action: 'created', id: created.rows[0].id };
  }

  await pool.query(
    `UPDATE platform.users
        SET password_hash = $2, role = 'SUPER_ADMIN', break_glass = true, status = 'active', failed_logins = 0, locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [existing.rows[0].id, hash],
  );
  return { action: 'reset', id: existing.rows[0].id };
}
