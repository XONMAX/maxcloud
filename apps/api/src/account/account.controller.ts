import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, Public, type AuthContext } from '../common/auth.guard';
import { PrismaService } from '../common/prisma.service';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { AccountService } from './account.service';

const AbuseSchema = z.object({
  kind: z.enum(['DMCA', 'ABUSE', 'MALWARE']),
  shareToken: z.string().max(100).optional(),
  reporterEmail: z.string().email(),
  reporterName: z.string().max(200).optional(),
  description: z.string().min(20).max(5000),
  /** DMCA §512(c)(3) statements: good-faith belief + accuracy under penalty of perjury. */
  goodFaith: z.boolean().optional(),
});

@Controller()
export class AccountController {
  constructor(private account: AccountService, private prisma: PrismaService) {}

  @RateLimit({ limit: 5, windowSec: 3600, bucket: 'export' })
  @Get('account/export')
  async export(@Auth() a: AuthContext, @Res() res: Response) {
    const data = await this.account.export(a.userId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="maxcloud-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 2));
  }

  @HttpCode(200)
  @Post('account/delete')
  delete(@Auth() a: AuthContext) {
    return this.account.requestDeletion(a.userId);
  }

  @HttpCode(200)
  @Post('account/delete/cancel')
  cancelDelete(@Auth() a: AuthContext) {
    return this.account.cancelDeletion(a.userId);
  }

  /** DMCA / abuse intake (public). Reviewed in the admin panel. */
  @Public()
  @RateLimit({ limit: 5, windowSec: 3600, bucket: 'abuse' })
  @Post('public/abuse-reports')
  async report(@Body(new ZodPipe(AbuseSchema)) b: z.infer<typeof AbuseSchema>) {
    if (b.kind === 'DMCA' && !b.goodFaith) return { ok: false, message: 'DMCA notices must include the good-faith statement' };
    let nodeId: string | null = null;
    if (b.shareToken) nodeId = (await this.prisma.shareLink.findUnique({ where: { token: b.shareToken } }))?.nodeId ?? null;
    const r = await this.prisma.abuseReport.create({
      data: { kind: b.kind, shareToken: b.shareToken, nodeId, reporterEmail: b.reporterEmail, reporterName: b.reporterName, description: b.description },
    });
    return { ok: true, id: r.id };
  }
}
