import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { QuotaOverrideSchema, type EconomicsInput } from '@maxcloud/shared';
import { AdminOnly, Auth, type AuthContext } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { AdminService } from './admin.service';

const UsersQuery = z.object({ q: z.string().max(200).default(''), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const AbuseQuery = z.object({ status: z.enum(['OPEN', 'ACTIONED', 'REJECTED']).optional() });
const ResolveSchema = z.object({ action: z.enum(['ACTIONED', 'REJECTED']), resolution: z.string().min(3).max(1000) });
const EconomicsSchema = z.object({
  provider: z.enum(['b2', 'r2', 'wasabi']),
  gatewayShare: z.record(z.enum(['stripe', 'payme', 'click']), z.number().min(0).max(1)),
  freeUsers: z.number().int().min(0),
  freeAvgStoredGB: z.number().min(0),
  overheadFraction: z.number().min(0).max(1).optional(),
  cogsAlertRatio: z.number().min(0).max(1).optional(),
  mix: z.array(
    z.object({
      planId: z.enum(['s50', 's100', 's250', 's500', 's1000']),
      interval: z.enum(['month', 'year']),
      subscribers: z.number().int().min(0),
      avgUtilization: z.number().min(0).max(1),
    }),
  ),
});

@AdminOnly()
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @HttpCode(200)
  @Post('economics')
  economics(@Body(new ZodPipe(EconomicsSchema)) b: z.infer<typeof EconomicsSchema>) {
    return this.admin.economics(b as EconomicsInput);
  }

  @Get('users')
  users(@Query(new ZodPipe(UsersQuery)) q: z.infer<typeof UsersQuery>) {
    return this.admin.users(q.q, q.cursor, q.limit);
  }

  @HttpCode(200)
  @Post('users/:id/quota')
  quota(@Auth() a: AuthContext, @Param('id') id: string, @Body(new ZodPipe(QuotaOverrideSchema)) b: z.infer<typeof QuotaOverrideSchema>) {
    return this.admin.overrideQuota(a.userId, id, b.quotaBytes, b.reason);
  }

  @Get('abuse-reports')
  abuse(@Query(new ZodPipe(AbuseQuery)) q: z.infer<typeof AbuseQuery>) {
    return this.admin.abuseReports(q.status);
  }

  @HttpCode(200)
  @Post('abuse-reports/:id/resolve')
  resolve(@Auth() a: AuthContext, @Param('id') id: string, @Body(new ZodPipe(ResolveSchema)) b: z.infer<typeof ResolveSchema>) {
    return this.admin.resolveAbuse(a.userId, id, b.action, b.resolution);
  }
}
