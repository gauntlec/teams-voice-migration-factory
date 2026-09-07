import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { APP_CONFIG, type AppConfig } from '../common/config';

// Accept codes from +/- N 30-second steps to tolerate clock drift between the
// server (container host clock) and the user's authenticator app. 2 => +/- 60s.
authenticator.options = { window: 2 };

@Injectable()
export class TotpService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  otpauthUrl(email: string, secret: string): string {
    return authenticator.keyuri(email, this.cfg.TOTP_ISSUER, secret);
  }

  verify(token: string, secret: string): boolean {
    try {
      return authenticator.verify({ token, secret });
    } catch {
      return false;
    }
  }

  /** Seconds the server clock is off from a reference (for diagnostics only). */
  now(): number {
    return Date.now();
  }
}
