import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FILE_STORAGE_BACKEND } from './file-storage.interface';
import { LocalDiskStorageBackend } from './local-disk-storage.backend';

@Module({
  controllers: [FilesController],
  providers: [FilesService, { provide: FILE_STORAGE_BACKEND, useClass: LocalDiskStorageBackend }],
  exports: [FilesService],
})
export class FilesModule {}
