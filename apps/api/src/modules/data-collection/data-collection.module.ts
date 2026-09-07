import { Module } from '@nestjs/common';
import { DataCollectionController } from './data-collection.controller';

@Module({ controllers: [DataCollectionController] })
export class DataCollectionModule {}
