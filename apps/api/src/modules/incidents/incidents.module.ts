import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';

@Module({
  // FilesModule: incident attachments.
  imports: [FilesModule],
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
