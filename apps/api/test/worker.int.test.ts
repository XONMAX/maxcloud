import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { WorkerModule } from '../src/jobs/worker.module';
import { MaintenanceProcessor } from '../src/jobs/maintenance.processor';
import { MediaProcessor } from '../src/jobs/media.processor';

describe('worker process', () => {
  it('resolves its full dependency graph (catches DI cycles before deploy)', async () => {
    const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    expect(ctx.get(MaintenanceProcessor)).toBeDefined();
    expect(ctx.get(MediaProcessor)).toBeDefined();
    const r = await ctx.get(MaintenanceProcessor).run({ kind: 'expire-uploads' });
    expect(r).toHaveProperty('aborted');
    await ctx.close();
  });
});
