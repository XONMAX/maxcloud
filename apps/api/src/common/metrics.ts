import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'maxcloud_' });

export const httpDuration = new client.Histogram({
  name: 'maxcloud_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const uploadsCompleted = new client.Counter({ name: 'maxcloud_uploads_completed_total', help: 'Completed uploads', registers: [registry] });
export const uploadBytes = new client.Counter({ name: 'maxcloud_upload_bytes_total', help: 'Bytes stored by completed uploads', registers: [registry] });
export const quotaRejections = new client.Counter({ name: 'maxcloud_quota_rejections_total', help: 'Uploads rejected by quota', registers: [registry] });
export const webhookEvents = new client.Counter({
  name: 'maxcloud_webhook_events_total',
  help: 'Billing webhook events',
  labelNames: ['provider', 'type', 'result'],
  registers: [registry],
});
export const quotaDrift = new client.Gauge({ name: 'maxcloud_quota_drift_users', help: 'Users whose usedBytes drifted from actual (last reconcile)', registers: [registry] });

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req.route?.path as string | undefined) ?? 'unmatched';
    end({ method: req.method, route: `${req.baseUrl ?? ''}${route}`, status: String(res.statusCode) });
  });
  next();
}
