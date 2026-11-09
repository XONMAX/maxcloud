import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ChangePlanSchema, CheckoutSchema } from '@maxcloud/shared';
import { Auth, Public, type AuthContext } from '../common/auth.guard';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { BillingService } from './billing.service';
import { InvoicesService } from './invoices.service';

@Controller('billing')
export class BillingController {
  constructor(private billing: BillingService, private invoices: InvoicesService) {}

  @Public()
  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  @Get()
  status(@Auth() a: AuthContext) {
    return this.billing.status(a.userId);
  }

  @RateLimit({ limit: 20, windowSec: 60, bucket: 'checkout' })
  @HttpCode(200)
  @Post('checkout')
  checkout(@Auth() a: AuthContext, @Body(new ZodPipe(CheckoutSchema)) b: z.infer<typeof CheckoutSchema>) {
    return this.billing.checkout(a.userId, b.planId, b.interval, b.provider);
  }

  @HttpCode(200)
  @Post('change-plan')
  changePlan(@Auth() a: AuthContext, @Body(new ZodPipe(ChangePlanSchema)) b: z.infer<typeof ChangePlanSchema>) {
    return this.billing.changePlan(a.userId, b.planId, b.interval);
  }

  @HttpCode(200)
  @Post('portal')
  portal(@Auth() a: AuthContext) {
    return this.billing.portal(a.userId);
  }

  @Get('invoices/:id/pdf')
  async invoicePdf(@Auth() a: AuthContext, @Param('id') id: string, @Res() res: Response) {
    const { filename, buffer } = await this.invoices.pdf(a.userId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** Stripe webhook. Signature is verified against the raw body. 2xx = processed or duplicate; 5xx = Stripe retries. */
  @Public()
  @HttpCode(200)
  @Post('webhooks/stripe')
  async stripeWebhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') sig: string | undefined) {
    const processed = await this.billing.handleStripeWebhook(req.rawBody ?? Buffer.alloc(0), sig);
    return { received: true, duplicate: !processed };
  }
}
