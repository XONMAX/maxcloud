import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { allowedOrigins } from './config';
import { metricsMiddleware } from './common/metrics';

/** Builds the HTTP app. Shared by main.ts, integration tests and the OpenAPI generator. */
export async function createApp(opts: { logger?: boolean } = {}) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, logger: opts.logger === false ? false : undefined, bodyParser: false });
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  app.set('trust proxy', 1); // behind Cloudflare / Fly proxy: req.ip = client IP
  app.use(helmet());
  // Stripe needs the raw body to verify signatures.
  app.use(json({ limit: '2mb', verify: (req, _res, buf) => ((req as unknown as { rawBody: Buffer }).rawBody = buf) }));
  app.use(cookieParser());
  app.use(metricsMiddleware);
  app.enableCors({ origin: allowedOrigins(), credentials: true });
  app.enableShutdownHooks();
  return app;
}
