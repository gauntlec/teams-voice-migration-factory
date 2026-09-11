import { Module } from '@nestjs/common';
import { BuildController } from './build.controller';
import { BuildService } from './build.service';
import { BuildValidationService } from './build-validation.service';

@Module({
  controllers: [BuildController],
  providers: [BuildService, BuildValidationService],
  exports: [BuildService],
})
export class BuildModule {}
