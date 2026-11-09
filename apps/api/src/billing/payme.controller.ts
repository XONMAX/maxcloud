import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Public } from '../common/auth.guard';
import { RateLimit } from '../common/rate-limit.guard';
import { PaymeProvider } from './providers/payme.provider';

/**
 * Payme Merchant API endpoint. Configure in the Payme business cabinet as
 *   https://api.maxcloud.uz/billing/payme
 * Restrict at the edge to Payme's IP ranges (Cloudflare WAF rule, see infra/cloudflare).
 */
@Public()
@Controller('billing/payme')
export class PaymeController {
  constructor(private payme: PaymeProvider) {}

  @RateLimit({ limit: 600, windowSec: 60, bucket: 'payme' })
  @HttpCode(200)
  @Post()
  rpc(@Headers('authorization') auth: string | undefined, @Body() body: unknown) {
    return this.payme.handle(auth, body);
  }
}
