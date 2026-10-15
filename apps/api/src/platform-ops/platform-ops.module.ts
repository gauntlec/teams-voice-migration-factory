import { Module } from '@nestjs/common';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformOpsController } from './platform-ops.controller';

@Module({ controllers: [PlatformOpsController], providers: [PlatformSettingsService], exports: [PlatformSettingsService] })
export class PlatformOpsModule {}
