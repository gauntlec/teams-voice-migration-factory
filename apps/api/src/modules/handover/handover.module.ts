import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { HandoverController } from './handover.controller';
import { HandoverDocumentService } from './handover-document.service';
import { HandoverService } from './handover.service';

@Module({
  imports: [FilesModule],
  controllers: [HandoverController],
  providers: [HandoverService, HandoverDocumentService],
  exports: [HandoverService],
})
export class HandoverModule {}
