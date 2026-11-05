import { Module } from '@nestjs/common';
import { BuildModule } from '../build/build.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

@Module({
  // BuildModule: BuildService.siteRollup, the per-site validation issue count.
  imports: [BuildModule],
  controllers: [ProgressController],
  providers: [ProgressService],
  // InsightsModule builds its figures on the same progress rules.
  exports: [ProgressService],
})
export class ProgressModule {}
