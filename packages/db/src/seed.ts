/**
 * Creates the bootstrap super admin from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, on first start only.
 * An existing account is left alone (so a password changed in the app survives restarts) unless
 * BOOTSTRAP_ADMIN_RESET=true, which puts it back with the password from the environment. Safe to re-run.
 *
 *   npm run seed --workspace @tvmf/db
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { seedBootstrapAdmin } from './bootstrap-admin';
import { migratePlatform } from './migrate';

async function main() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim();
  if (!email) throw new Error('Set BOOTSTRAP_ADMIN_EMAIL');
  const reset = (process.env.BOOTSTRAP_ADMIN_RESET ?? '').toLowerCase() === 'true';

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migratePlatform(pool);
    const r = await seedBootstrapAdmin(pool, { email, password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '', reset });
    // eslint-disable-next-line no-console
    console.log(
      r.action === 'created'
        ? `Created super admin ${email} (${r.id}). Sign in at the web app; you will be asked to enrol TOTP on first login.`
        : r.action === 'reset'
          ? `Reset super admin ${email} (${r.id}): new password, role Super Admin, active, unlocked. Remove BOOTSTRAP_ADMIN_RESET so a restart does not do this again.`
          : `Super admin ${email} already exists - left unchanged.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
