import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { DeviceStatusController } from './device-status.controller';
import { DeviceStatusService } from './device-status.service';

// MailModule: the "send me a test alert" action.
@Module({ imports: [MailModule], controllers: [DeviceStatusController], providers: [DeviceStatusService] })
export class DeviceStatusModule {}
