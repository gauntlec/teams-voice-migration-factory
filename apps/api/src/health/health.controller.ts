import { Controller, Get } from '@nestjs/common';
import { sql } from 'kysely';
import { Public } from '../auth/auth.decorators';
import { InjectDb, type Db } from '../db/db.module';

@Controller('health')
export class HealthController {
  constructor(@InjectDb() private readonly db: Db) {}

  @Public()
  @Get()
  async health() {
    let db = 'ok';
    try {
      await sql`select 1`.execute(this.db);
    } catch {
      db = 'down';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      // Compare `ts` / `epoch` to your own clock — TOTP needs them within ~60s.
      ts: new Date().toISOString(),
      epoch: Math.floor(Date.now() / 1000),
    };
  }
}
