/**
 * Creates (or resets the password of) the bootstrap super admin from
 * BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD. Safe to re-run.
 *
 *   npm run seed --workspace @tvmf/db
 */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { migratePlatform } from './migrate';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

async function main() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').toLowerCase().trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (!email || !password) {
    throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD');
  }
  if (password.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migratePlatform(pool);
    const hash = await argon2.hash(password, ARGON);
    const { rows } = await pool.query<{ id: string; created: boolean }>(
      `INSERT INTO platform.users (email, password_hash, display_name, role)
       VALUES ($1, $2, 'Platform Admin', 'SUPER_ADMIN')
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = 'SUPER_ADMIN',
             status = 'active',
             failed_logins = 0,
             locked_until = NULL,
             updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [email, hash],
    );
    const row = rows[0]!;
    // eslint-disable-next-line no-console
    console.log(`${row.created ? 'Created' : 'Updated'} super admin ${email} (${row.id}).`);
    // eslint-disable-next-line no-console
    console.log('Sign in at the web app; you will be asked to enrol TOTP on first login.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
