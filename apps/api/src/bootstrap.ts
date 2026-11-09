import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, type NextFunction, type Request, type Response } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { allowedOrigins, config } from './config';
import { metricsMiddleware } from './common/metrics';

/** Builds the HTTP app. Shared by main.ts, integration tests and the OpenAPI generator. */
export async function createApp(opts: { logger?: boolean } = {}) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, logger: opts.logger === false ? false : undefined, bodyParser: false });
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  app.set('trust proxy', 1); // behind Cloudflare / Fly proxy: req.ip = client IP
  app.use(helmet());
  // Stripe needs the raw body to verify signatures.
  app.use(json({ limit: '2mb', verify: (req, _res, buf) => ((req as unknown as { rawBody: Buffer }).rawBody = buf) }));
  // Payme expects JSON-RPC parse errors as HTTP 200 with code -32700.
  app.use((err: { type?: string }, req: Request, res: Response, next: NextFunction) => {
    if (err?.type === 'entity.parse.failed' && req.path.startsWith('/billing/payme')) {
      return res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: { uz: 'JSON xato', ru: 'Ошибка парсинга JSON', en: 'Parse error' } } });
    }
    next(err);
  });
  app.use(cookieParser());
  app.use(metricsMiddleware);
  app.enableCors({ origin: allowedOrigins(), credentials: true });
  app.enableShutdownHooks();
  const prefix = config().API_BASE_PATH.replace(/^\//, '');
  if (prefix) app.setGlobalPrefix(prefix);
  return app;
}
