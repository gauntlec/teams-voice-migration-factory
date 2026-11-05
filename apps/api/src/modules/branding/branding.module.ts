import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { DocumentBrandingController } from './document-branding.controller';
import { DocumentBrandingService } from './document-branding.service';

/** Document branding (docs/BRANDING.md): whose branding every generated document carries. */
@Module({
  imports: [FilesModule],
  controllers: [DocumentBrandingController],
  providers: [DocumentBrandingService],
  exports: [DocumentBrandingService],
})
export class BrandingModule {}
