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
// SLICE: import { SharesController } from './sharing/shares.controller';
// SLICE: import { PublicSharesController } from './sharing/public-shares.controller';
// SLICE: import { SharesService } from './sharing/shares.service';
import { QuotaService } from './quota/quota.service';
// SLICE: import { BillingController } from './billing/billing.controller';
// SLICE: import { BillingService } from './billing/billing.service';
// SLICE: import { StripeProvider } from './billing/providers/stripe.provider';
// SLICE: import { PaymeProvider } from './billing/providers/payme.provider';
// SLICE: import { ClickProvider } from './billing/providers/click.provider';
// SLICE: import { UzumProvider } from './billing/providers/uzum.provider';
// SLICE: import { InvoicesService } from './billing/invoices.service';
// SLICE: import { PaymeController } from './billing/payme.controller';
// SLICE: import { AdminController } from './admin/admin.controller';
// SLICE: import { AdminService } from './admin/admin.service';
// SLICE: import { AccountController } from './account/account.controller';
// SLICE: import { AccountService } from './account/account.service';

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
    // SLICE: SharesController,
    // SLICE: PublicSharesController,
    // SLICE: BillingController,
    // SLICE: PaymeController,
    // SLICE: AdminController,
    // SLICE: AccountController,
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
    // SLICE: SharesService,
    QuotaService,
    // SLICE: BillingService,
    // SLICE: StripeProvider,
    // SLICE: PaymeProvider,
    // SLICE: ClickProvider,
    // SLICE: UzumProvider,
    // SLICE: InvoicesService,
    // SLICE: AdminService,
    // SLICE: AccountService,
  ],
})
export class AppModule {}
