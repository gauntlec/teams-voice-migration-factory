import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformOpsController } from './platform-ops.controller';

@Module({ imports: [MailModule], controllers: [PlatformOpsController], providers: [PlatformSettingsService], exports: [PlatformSettingsService] })
export class PlatformOpsModule {}
