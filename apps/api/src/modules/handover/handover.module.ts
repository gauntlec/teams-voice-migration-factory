import { Module } from '@nestjs/common';
import { HandoverController } from './handover.controller';

@Module({ controllers: [HandoverController] })
export class HandoverModule {}
