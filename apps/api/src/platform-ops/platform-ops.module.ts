import { Module } from '@nestjs/common';
import { BaseUrlService } from './base-url.service';
import { PlatformOpsController } from './platform-ops.controller';

@Module({ controllers: [PlatformOpsController], providers: [BaseUrlService], exports: [BaseUrlService] })
export class PlatformOpsModule {}
