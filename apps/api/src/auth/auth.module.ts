import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, TotpService],
  exports: [TokenService],
})
export class AuthModule {}
