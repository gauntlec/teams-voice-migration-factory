import { Module } from '@nestjs/common';
import { DataCollectionController } from './data-collection.controller';
import { DataCollectionService } from './data-collection.service';
import { TelephonyController } from './data-collection.telephony.controller';
import { TelephonyService } from './data-collection.telephony.service';
import { GeocodeService } from './geocode.service';

@Module({
  controllers: [DataCollectionController, TelephonyController],
  providers: [DataCollectionService, TelephonyService, GeocodeService],
})
export class DataCollectionModule {}
