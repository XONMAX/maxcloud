import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CreateShareLinkSchema, ShareFolderSchema } from '@maxcloud/shared';
import { Auth, type AuthContext } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { SharesService } from './shares.service';

const LinksQuery = z.object({ nodeId: z.string().optional() });

@Controller()
export class SharesController {
  constructor(private shares: SharesService) {}

  @Post('share-links')
  create(@Auth() a: AuthContext, @Body(new ZodPipe(CreateShareLinkSchema)) b: z.infer<typeof CreateShareLinkSchema>) {
    return this.shares.createLink(a.userId, b);
  }

  @Get('share-links')
  list(@Auth() a: AuthContext, @Query(new ZodPipe(LinksQuery)) q: z.infer<typeof LinksQuery>) {
    return this.shares.listLinks(a.userId, q.nodeId);
  }

  @Delete('share-links/:id')
  revoke(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.shares.revokeLink(a.userId, id);
  }

  @Post('folders/:id/shares')
  shareFolder(@Auth() a: AuthContext, @Param('id') id: string, @Body(new ZodPipe(ShareFolderSchema)) b: z.infer<typeof ShareFolderSchema>) {
    return this.shares.shareFolder(a.userId, id, b.email, b.role);
  }

  @Get('folders/:id/shares')
  folderShares(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.shares.listFolderShares(a.userId, id);
  }

  @Delete('folders/:id/shares/:granteeId')
  unshare(@Auth() a: AuthContext, @Param('id') id: string, @Param('granteeId') granteeId: string) {
    return this.shares.removeFolderShare(a.userId, id, granteeId);
  }
}
