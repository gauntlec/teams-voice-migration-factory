import { Module } from '@nestjs/common';
import { BuildModule } from '../build/build.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

@Module({
  // BuildModule: BuildService.siteRollup, the per-site validation issue count.
  imports: [BuildModule],
  controllers: [ProgressController],
  providers: [ProgressService],
})
export class ProgressModule {}
