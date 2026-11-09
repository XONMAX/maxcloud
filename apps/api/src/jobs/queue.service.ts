import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../common/redis.service';

export const MEDIA_QUEUE = 'media';
export const MAINTENANCE_QUEUE = 'maintenance';

export interface MediaJob {
  versionId: string;
}

export type MaintenanceJob =
  | { kind: 'quota-tick' }
  | { kind: 'purge-trash' }
  | { kind: 'expire-uploads' }
  | { kind: 'reconcile-usage' }
  | { kind: 'purge-over-quota'; userId: string }
  | { kind: 'renewal-reminders' }
  | { kind: 'delete-accounts' };

/** Producer side of BullMQ. Consumers live in src/worker.ts (separate process). */
@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly media: Queue<MediaJob>;
  readonly maintenance: Queue<MaintenanceJob>;

  constructor(redis: RedisService) {
    const connection = redis.duplicate();
    const defaultJobOptions = { attempts: 5, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 };
    this.media = new Queue(MEDIA_QUEUE, { connection, defaultJobOptions });
    this.maintenance = new Queue(MAINTENANCE_QUEUE, { connection, defaultJobOptions });
  }

  enqueueMedia(versionId: string) {
    return this.media.add('process', { versionId }, { jobId: `media-${versionId}` });
  }

  async onModuleDestroy() {
    await Promise.all([this.media.close(), this.maintenance.close()]);
  }
}
