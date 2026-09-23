import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, TotpService, LoginRateLimitGuard],
  exports: [TokenService],
})
export class AuthModule {}
