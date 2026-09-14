import { Module } from '@nestjs/common';
import { FilesModule } from '../modules/files/files.module';
import { MspLogoPublicController } from './msp-logo-public.controller';
import { MspsController } from './msps.controller';
import { MspsService } from './msps.service';

@Module({
  imports: [FilesModule],
  controllers: [MspsController, MspLogoPublicController],
  providers: [MspsService],
})
export class MspsModule {}
