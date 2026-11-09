import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nestjs';
import type { Response } from 'express';

/** Normalises every error to { code, message } and reports unexpected ones to Sentry. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const status = exception.getStatus();
      if (typeof body === 'object' && body && 'code' in body) return res.status(status).json(body);
      const message = typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);
      return res.status(status).json({ code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message });
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') return res.status(409).json({ code: 'CONFLICT', message: 'An item with this name already exists here' });
      if (exception.code === 'P2025') return res.status(404).json({ code: 'NOT_FOUND', message: 'Not found' });
    }
    this.log.error(exception instanceof Error ? exception.stack : String(exception));
    Sentry.captureException(exception);
    return res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong' });
  }
}
