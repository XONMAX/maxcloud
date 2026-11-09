import './instrument';
import { createApp } from './bootstrap';
import { allowedOrigins, config } from './config';
import { StorageService } from './storage/storage.service';

async function main() {
  const app = await createApp();
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
