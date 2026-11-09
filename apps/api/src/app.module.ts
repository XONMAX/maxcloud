import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { config } from './config';
import { AuthGuard } from './common/auth.guard';
import { AllExceptionsFilter } from './common/exception.filter';
import { PrismaService } from './common/prisma.service';
import { RateLimitGuard } from './common/rate-limit.guard';
import { RedisService } from './common/redis.service';
import { MailService } from './mail/mail.service';
import { StorageService } from './storage/storage.service';
import { HealthController } from './health/health.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { OAuthService } from './auth/oauth.service';
import { TokensService } from './auth/tokens.service';
import { QueueService } from './jobs/queue.service';
import { AccessService } from './files/access.service';
import { FilesController } from './files/files.controller';
import { FilesService } from './files/files.service';
import { UploadsService } from './files/uploads.service';
import { UploadsController } from './files/uploads.controller';
import { SharesController } from './sharing/shares.controller';
import { PublicSharesController } from './sharing/public-shares.controller';
import { SharesService } from './sharing/shares.service';
import { QuotaService } from './quota/quota.service';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { StripeProvider } from './billing/providers/stripe.provider';
import { PaymeProvider } from './billing/providers/payme.provider';
import { ClickProvider } from './billing/providers/click.provider';
import { UzumProvider } from './billing/providers/uzum.provider';
import { InvoicesService } from './billing/invoices.service';
import { PaymeController } from './billing/payme.controller';
// SLICE: import { AdminController } from './admin/admin.controller';
// SLICE: import { AdminService } from './admin/admin.service';
import { AccountController } from './account/account.controller';
import { AccountService } from './account/account.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, MailService, StorageService, QueueService],
  exports: [PrismaService, RedisService, MailService, StorageService, QueueService],
})
export class CoreModule {}

@Module({
  imports: [
    CoreModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: config().LOG_LEVEL,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        // Keep request logs short and PII-light: method, url, status, timing, ip.
        serializers: {
          req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0], ip: req.remoteAddress }),
          res: (res: { statusCode: number }) => ({ status: res.statusCode }),
        },
        transport: config().NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
      },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    FilesController,
    UploadsController,
    SharesController,
    PublicSharesController,
    BillingController,
    PaymeController,
    // SLICE: AdminController,
    AccountController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    AuthService,
    OAuthService,
    TokensService,
    AccessService,
    FilesService,
    UploadsService,
    SharesService,
    QuotaService,
    BillingService,
    StripeProvider,
    PaymeProvider,
    ClickProvider,
    UzumProvider,
    InvoicesService,
    // SLICE: AdminService,
    AccountService,
  ],
})
export class AppModule {}
