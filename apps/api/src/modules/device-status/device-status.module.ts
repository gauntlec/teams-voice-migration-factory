import { Module } from '@nestjs/common';
import { DeviceStatusController } from './device-status.controller';
import { DeviceStatusService } from './device-status.service';

@Module({ controllers: [DeviceStatusController], providers: [DeviceStatusService] })
export class DeviceStatusModule {}
