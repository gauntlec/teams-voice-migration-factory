import { Module } from '@nestjs/common';
import { BuildController } from './build.controller';

@Module({ controllers: [BuildController] })
export class BuildModule {}
