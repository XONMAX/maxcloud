import { Injectable, Logger } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { config } from '../config';
import { hmac } from '../common/crypto';

export function contentDisposition(filename: string, inline: boolean) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Thin wrapper over the S3 API. Works with Backblaze B2, Cloudflare R2,
 * Wasabi and any S3-compatible server. File bytes never flow through the API:
 * clients upload parts with presigned PUT URLs and download with presigned
 * GET URLs (or via the Cloudflare download Worker in production).
 */
@Injectable()
export class StorageService {
  private log = new Logger(StorageService.name);
  readonly s3: S3Client;
  /** Signs URLs with the public host so browsers can reach them. */
  private presigner: S3Client;
  readonly bucket: string;

  constructor() {
    const c = config();
    const base = {
      region: c.S3_REGION,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY },
      // B2/R2 don't support the newer default integrity checksums on presigned PUTs.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.s3 = new S3Client({ ...base, endpoint: c.S3_ENDPOINT });
    this.presigner = new S3Client({ ...base, endpoint: c.S3_PUBLIC_ENDPOINT ?? c.S3_ENDPOINT });
    this.bucket = c.S3_BUCKET;
  }

  private sse() {
    return config().S3_SSE === 'AES256' ? { ServerSideEncryption: 'AES256' as const } : {};
  }

  async ping() {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /** Dev helper: create bucket + CORS so the browser can PUT parts and read ETag. In prod use infra/ scripts. */
  async ensureBucket(origins: string[]) {
    try {
      await this.ping();
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.log.log(`Created bucket ${this.bucket}`);
    }
    await this.s3.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            { AllowedOrigins: origins, AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
          ],
        },
      }),
    );
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const r = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ...this.sse() }));
    if (!r.UploadId) throw new Error('S3 returned no UploadId');
    return r.UploadId;
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresIn = 3600) {
    return getSignedUrl(this.presigner, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });
  }

  async listParts(key: string, uploadId: string): Promise<Part[]> {
    const parts: Part[] = [];
    let marker: string | undefined;
    for (;;) {
      const r = await this.s3.send(new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000 }));
      parts.push(...(r.Parts ?? []));
      if (!r.IsTruncated) break;
      marker = r.NextPartNumberMarker;
    }
    return parts;
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string) {
    try {
      await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (e) {
      this.log.warn(`abort ${key} failed: ${(e as Error).message}`);
    }
  }

  async head(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ...this.sse() }));
  }

  async getStream(key: string): Promise<Readable> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body as Readable;
  }

  async deleteMany(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (!chunk.length) continue;
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  /**
   * Short-lived download URL.
   *  presigned: S3 presigned GET (R2, local dev).
   *  worker: HMAC-signed URL for the Cloudflare download Worker (infra/cloudflare/download-worker),
   *          which fetches from the private B2 bucket. B2 -> Cloudflare egress is free (Bandwidth Alliance).
   */
  async downloadUrl(key: string, filename: string, opts: { inline?: boolean; contentType?: string; expiresIn?: number } = {}) {
    const c = config();
    const expiresIn = opts.expiresIn ?? 3600;
    const disposition = contentDisposition(filename, !!opts.inline);
    if (c.DOWNLOAD_MODE === 'worker') {
      if (!c.DOWNLOAD_BASE_URL || !c.DOWNLOAD_SIGNING_SECRET) throw new Error('DOWNLOAD_BASE_URL and DOWNLOAD_SIGNING_SECRET are required for worker downloads');
      const exp = Math.floor(Date.now() / 1000) + expiresIn;
      const ct = opts.contentType ?? '';
      const sig = hmac(c.DOWNLOAD_SIGNING_SECRET, `${key}\n${exp}\n${disposition}\n${ct}`);
      const q = new URLSearchParams({ exp: String(exp), d: disposition, ct, sig });
      return `${c.DOWNLOAD_BASE_URL.replace(/\/$/, '')}/${key}?${q}`;
    }
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition, ResponseContentType: opts.contentType }),
      { expiresIn },
    );
  }
}
