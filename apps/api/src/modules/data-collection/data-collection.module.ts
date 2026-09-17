import { Module } from '@nestjs/common';
import { DataCollectionController } from './data-collection.controller';
import { DataCollectionService } from './data-collection.service';
import { TelephonyController } from './data-collection.telephony.controller';
import { TelephonyService } from './data-collection.telephony.service';
import { GeocodeService } from './geocode.service';

@Module({
  controllers: [DataCollectionController, TelephonyController],
  providers: [DataCollectionService, TelephonyService, GeocodeService],
  // Discovery's "import users"/"import resource accounts" respect the same
  // draft/submitted/accepted lock, and reuse TelephonyService's e164->sitecode
  // map for site suggestions (see TenantDiscoveryService.importPreview).
  exports: [DataCollectionService, TelephonyService],
})
export class DataCollectionModule {}
