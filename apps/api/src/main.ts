import './instrument';
import { createApp } from './bootstrap';
import { allowedOrigins, config } from './config';
import { StorageService } from './storage/storage.service';
import { PrismaService } from './common/prisma.service';
import { syncPlans } from './billing/plans.sync';

async function main() {
  const app = await createApp();
  // Keep the Plan table in sync with @maxcloud/shared (idempotent upsert).
  await syncPlans(app.get(PrismaService));
  if (config().NODE_ENV !== 'production') {
    // Local S3 (VersityGW) needs the bucket + CORS created; production buckets are provisioned by infra/.
    await app.get(StorageService).ensureBucket(allowedOrigins());
  }
  await app.listen(config().PORT, '0.0.0.0');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
