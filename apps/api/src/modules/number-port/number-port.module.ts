import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { FilesModule } from '../files/files.module';
import { NumberPortController } from './number-port.controller';
import { NumberPortService } from './number-port.service';

@Module({
  imports: [FilesModule, MailModule],
  controllers: [NumberPortController],
  providers: [NumberPortService],
})
export class NumberPortModule {}
