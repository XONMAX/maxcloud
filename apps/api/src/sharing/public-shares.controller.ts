import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { UnlockShareSchema } from '@maxcloud/shared';
import { Public } from '../common/auth.guard';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { config } from '../config';
import { SharesService } from './shares.service';

const NodeQuery = z.object({ nodeId: z.string().optional(), parentId: z.string().optional(), inline: z.enum(['0', '1']).default('0') });

/** Cookie (web) or X-Share-Token header (native apps) carrying the unlocked-link proof. */
function shareToken(req: Request, token: string) {
  return (req.headers['x-share-token'] as string | undefined) ?? (req.cookies as Record<string, string>)[`mc_share_${token}`];
}

@Public()
@Controller('public/shares/:token')
export class PublicSharesController {
  constructor(private shares: SharesService) {}

  @RateLimit({ limit: 120, windowSec: 60, bucket: 'share-meta' })
  @Get()
  meta(@Param('token') token: string, @Req() req: Request) {
    return this.shares.meta(token, shareToken(req, token));
  }

  /** Brute-force protection: 10 password attempts per minute per IP. */
  @RateLimit({ limit: 10, windowSec: 60, bucket: 'share-unlock' })
  @HttpCode(200)
  @Post('unlock')
  async unlock(@Param('token') token: string, @Body(new ZodPipe(UnlockShareSchema)) b: z.infer<typeof UnlockShareSchema>, @Res({ passthrough: true }) res: Response) {
    const r = await this.shares.unlock(token, b.password);
    res.cookie(`mc_share_${token}`, r.shareToken, { httpOnly: true, sameSite: 'lax', secure: config().COOKIE_SECURE, path: '/', maxAge: 2 * 3600_000 });
    return { shareToken: r.shareToken };
  }

  @RateLimit({ limit: 300, windowSec: 60, bucket: 'share-list' })
  @Get('files')
  list(@Param('token') token: string, @Req() req: Request, @Query(new ZodPipe(NodeQuery)) q: z.infer<typeof NodeQuery>) {
    return this.shares.listFolder(token, shareToken(req, token), q.parentId);
  }

  @RateLimit({ limit: 300, windowSec: 60, bucket: 'share-download' })
  @Get('download')
  download(@Param('token') token: string, @Req() req: Request, @Query(new ZodPipe(NodeQuery)) q: z.infer<typeof NodeQuery>) {
    return this.shares.download(token, shareToken(req, token), q.nodeId, q.inline === '1');
  }

  @RateLimit({ limit: 600, windowSec: 60, bucket: 'share-thumb' })
  @Get('thumbnail')
  thumbnail(@Param('token') token: string, @Req() req: Request, @Query(new ZodPipe(NodeQuery)) q: z.infer<typeof NodeQuery>) {
    return this.shares.thumbnail(token, shareToken(req, token), q.nodeId);
  }
}
