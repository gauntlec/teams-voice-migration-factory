import { Module } from '@nestjs/common';
import { PlatformOpsController } from './platform-ops.controller';

@Module({ controllers: [PlatformOpsController] })
export class PlatformOpsModule {}
