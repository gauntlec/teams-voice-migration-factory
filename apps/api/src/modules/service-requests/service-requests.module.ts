import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { MspServiceRequestsController } from './msp-service-requests.controller';
import { MspServiceRequestsService } from './msp-service-requests.service';
import { BuildModule } from '../build/build.module';
import { DataCollectionModule } from '../data-collection/data-collection.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { FilesModule } from '../files/files.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';
import { SrAgentApiController } from './sr-agent-api.controller';
import { SrAgentApiService } from './sr-agent-api.service';
import { SrAgentView } from './sr-agent-view.service';
import { SrAgentsController } from './sr-agents.controller';
import { SrAgentsService } from './sr-agents.service';
import { SrClaimsService } from './sr-claims.service';
import { SrProposalsService } from './sr-proposals.service';

@Module({
  // BuildModule / DataCollectionModule: "Create in Design & Build" reuses their create paths.
  // DeploymentModule: the request's Deploy tab runs the normal deployment path.
  // FilesModule: request attachments.
  // IncidentsModule: the agent events feed and the agent token guard.
  imports: [MailModule, BuildModule, DataCollectionModule, DeploymentModule, FilesModule, IncidentsModule],
  // SrAgentsController first: its fixed paths (agents, :id/takeover ...) must win over ServiceRequestsController's :id.
  controllers: [SrAgentsController, ServiceRequestsController, MspServiceRequestsController, SrAgentApiController],
  providers: [ServiceRequestsService, MspServiceRequestsService, SrClaimsService, SrAgentView, SrProposalsService, SrAgentsService, SrAgentApiService],
})
export class ServiceRequestsModule {}
