import { BrandingModule } from '../branding/branding.module';
import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { HandoverController } from './handover.controller';
import { HandoverDocumentService } from './handover-document.service';
import { PackPageNumbers } from './pack-page-numbers';
import { HandoverService } from './handover.service';

@Module({
  imports: [BrandingModule, FilesModule],
  controllers: [HandoverController],
  providers: [HandoverService, HandoverDocumentService, PackPageNumbers],
  exports: [HandoverService],
})
export class HandoverModule {}
