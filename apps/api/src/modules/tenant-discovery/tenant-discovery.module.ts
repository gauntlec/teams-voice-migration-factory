import { Module } from '@nestjs/common';
import { DataCollectionModule } from '../data-collection/data-collection.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { TenantDiscoveryController } from './tenant-discovery.controller';
import { TenantDiscoveryService } from './tenant-discovery.service';

@Module({
  imports: [DeploymentModule, DataCollectionModule],
  controllers: [TenantDiscoveryController],
  providers: [TenantDiscoveryService],
})
export class TenantDiscoveryModule {}
