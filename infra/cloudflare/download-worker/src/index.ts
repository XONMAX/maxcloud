/**
 * MaxCloud download gateway (Cloudflare Worker) — dl.maxcloud.uz/*
 *
 * Why: Backblaze B2 -> Cloudflare egress is free (Bandwidth Alliance), B2 -> internet is $0.01/GB.
 * Presigned B2 URLs can't be served from our domain (the signature covers B2's host), so this
 * Worker verifies our own short-lived HMAC URL, fetches from the *private* bucket with S3 SigV4
 * (aws4fetch) and streams it back with the right headers. Range requests pass through (video seek).
 */
import { AwsClient } from 'aws4fetch';
import { verify } from './sign';

export interface Env {
  DOWNLOAD_SIGNING_SECRET: string;
  B2_ENDPOINT: string; // e.g. https://s3.eu-central-003.backblazeb2.com
  B2_BUCKET: string;
  B2_KEY_ID: string;
  B2_APP_KEY: string;
  B2_REGION: string; // e.g. eu-central-003
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const url = new URL(req.url);
    const signed = await verify(url, env.DOWNLOAD_SIGNING_SECRET);
    if (!signed) return new Response('Link expired or invalid', { status: 403 });

    const aws = new AwsClient({ accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APP_KEY, service: 's3', region: env.B2_REGION });
    const upstreamUrl = `${env.B2_ENDPOINT}/${env.B2_BUCKET}/${signed.key.split('/').map(encodeURIComponent).join('/')}`;
    const headers: Record<string, string> = {};
    const range = req.headers.get('Range');
    if (range) headers.Range = range;
    const upstream = await aws.fetch(upstreamUrl, { method: req.method, headers });
    if (upstream.status === 404) return new Response('Not found', { status: 404 });
    if (!upstream.ok && upstream.status !== 206) return new Response('Storage error', { status: 502 });

    const out = new Headers();
    for (const h of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('Content-Type', signed.contentType || upstream.headers.get('Content-Type') || 'application/octet-stream');
    out.set('Content-Disposition', signed.disposition);
    out.set('Cache-Control', 'private, max-age=3600');
    out.set('X-Content-Type-Options', 'nosniff');
    // User content must never run scripts on our origin.
    out.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
