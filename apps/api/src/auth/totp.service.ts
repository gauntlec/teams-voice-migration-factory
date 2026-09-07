import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { APP_CONFIG, type AppConfig } from '../common/config';

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
}
