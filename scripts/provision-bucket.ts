/**
 * Production bucket setup (B2 / R2 / Wasabi) via the S3 API: CORS so browsers can PUT parts
 * and read ETag. Run once per bucket:
 *   S3_ENDPOINT=... S3_REGION=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... WEB_ORIGIN=https://maxcloud.uz \
 *   pnpm tsx scripts/provision-bucket.ts
 * Also do in the provider console (not exposed via S3 API on B2):
 *   - B2: bucket type "Private", default encryption SSE-B2 (AES-256), lifecycle "keep only the last version"
 *     (we delete objects ourselves; B2 keeps hidden versions otherwise and bills them).
 *   - Abandoned multipart parts are aborted by the worker's expire-uploads job every 15 min.
 */
import { PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});
const origins = [process.env.WEB_ORIGIN ?? 'https://maxcloud.uz', 'tauri://localhost', 'https://tauri.localhost'];

s3.send(
  new PutBucketCorsCommand({
    Bucket: process.env.S3_BUCKET!,
    CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }] },
  }),
)
  .then(() => console.log(`CORS set on ${process.env.S3_BUCKET} for ${origins.join(', ')}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
