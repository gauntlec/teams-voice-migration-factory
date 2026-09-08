import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
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

  /** PNG data URI of the otpauth URL, to scan directly from an authenticator app. */
  qrDataUrl(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl, { width: 240, margin: 1, errorCorrectionLevel: 'M' });
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
