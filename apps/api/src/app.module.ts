import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from './common/audit.service';
import { ConfigModule } from './common/config.module';
import { DbModule } from './db/db.module';
import { QueueModule } from './queue/queue.module';
import { RbacModule } from './rbac/rbac.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './rbac/permissions.guard';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TenantsModule } from './tenants/tenants.module';
import { DataCollectionModule } from './modules/data-collection/data-collection.module';
import { BuildModule } from './modules/build/build.module';
import { DeploymentModule } from './modules/deployment/deployment.module';
import { HandoverModule } from './modules/handover/handover.module';
import { AuditReadModule } from './modules/audit/audit-read.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    AuditModule,
    RbacModule,
    QueueModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    DataCollectionModule,
    BuildModule,
    DeploymentModule,
    HandoverModule,
    AuditReadModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
