import './instrument';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import { RedisService } from './common/redis.service';
import { MediaProcessor } from './jobs/media.processor';
import { MaintenanceProcessor } from './jobs/maintenance.processor';
import { WorkerModule } from './jobs/worker.module';
import { MAINTENANCE_QUEUE, MEDIA_QUEUE, QueueService, type MaintenanceJob, type MediaJob } from './jobs/queue.service';


/** Cron schedule for housekeeping (UTC). */
const SCHEDULES: { kind: MaintenanceJob['kind']; pattern: string }[] = [
  { kind: 'quota-tick', pattern: '17 * * * *' }, // hourly
  { kind: 'expire-uploads', pattern: '*/15 * * * *' },
  { kind: 'purge-trash', pattern: '40 2 * * *' }, // daily 02:40 UTC (07:40 Tashkent)
  { kind: 'reconcile-usage', pattern: '10 3 * * *' },
  { kind: 'renewal-reminders', pattern: '0 5 * * *' }, // 10:00 Tashkent
  { kind: 'delete-accounts', pattern: '25 4 * * *' },
];

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  const log = new Logger('Worker');
  const redis = app.get(RedisService);
  const queues = app.get(QueueService);
  const media = app.get(MediaProcessor);
  const maint = app.get(MaintenanceProcessor);

  for (const s of SCHEDULES) {
    await queues.maintenance.upsertJobScheduler(s.kind, { pattern: s.pattern }, { name: s.kind, data: { kind: s.kind } as MaintenanceJob });
  }

  const workers = [
    new Worker<MediaJob>(MEDIA_QUEUE, (job) => media.process(job.data.versionId), { connection: redis.duplicate(), concurrency: 4 }),
    new Worker<MaintenanceJob>(MAINTENANCE_QUEUE, (job) => maint.run(job.data), { connection: redis.duplicate(), concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => {
      log.error(`${w.name} job ${job?.id} failed: ${err.message}`);
      Sentry.captureException(err, { tags: { queue: w.name } });
    });
    w.on('completed', (job, res) => log.log(`${w.name} ${job.name} done ${JSON.stringify(res)}`));
  }
  log.log('worker started');

  const stop = async () => {
    await Promise.all(workers.map((w) => w.close()));
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
