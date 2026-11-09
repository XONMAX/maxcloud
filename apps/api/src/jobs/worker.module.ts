import { Module } from '@nestjs/common';
import { AppModule } from '../app.module';
import { MediaProcessor } from './media.processor';
import { MaintenanceProcessor } from './maintenance.processor';

@Module({ imports: [AppModule], providers: [MediaProcessor, MaintenanceProcessor] })
export class WorkerModule {}
