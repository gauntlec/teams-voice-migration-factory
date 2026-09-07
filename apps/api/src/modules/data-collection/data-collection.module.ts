import { Module } from '@nestjs/common';
import { DataCollectionController } from './data-collection.controller';
import { DataCollectionService } from './data-collection.service';

@Module({
  controllers: [DataCollectionController],
  providers: [DataCollectionService],
})
export class DataCollectionModule {}
