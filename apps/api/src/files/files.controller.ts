import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CreateFolderSchema, ListQuerySchema, MoveSchema, RenameSchema, SearchQuerySchema } from '@maxcloud/shared';
import { Auth, type AuthContext } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { FilesService } from './files.service';

const InlineSchema = z.object({ inline: z.enum(['0', '1']).default('0') });

@Controller()
export class FilesController {
  constructor(private files: FilesService) {}

  @Get('files')
  list(@Auth() a: AuthContext, @Query(new ZodPipe(ListQuerySchema)) q: z.infer<typeof ListQuerySchema>) {
    return this.files.list(a.userId, q);
  }

  @Get('files/search')
  search(@Auth() a: AuthContext, @Query(new ZodPipe(SearchQuerySchema)) q: z.infer<typeof SearchQuerySchema>) {
    return this.files.search(a.userId, q.q, q.kind, q.limit);
  }

  @Get('files/shared-with-me')
  shared(@Auth() a: AuthContext) {
    return this.files.sharedWithMe(a.userId);
  }

  @Get('files/:id')
  get(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.files.get(a.userId, id);
  }

  @Post('folders')
  createFolder(@Auth() a: AuthContext, @Body(new ZodPipe(CreateFolderSchema)) b: z.infer<typeof CreateFolderSchema>) {
    return this.files.createFolder(a.userId, b.name, b.parentId);
  }

  @Patch('files/:id/name')
  rename(@Auth() a: AuthContext, @Param('id') id: string, @Body(new ZodPipe(RenameSchema)) b: z.infer<typeof RenameSchema>) {
    return this.files.rename(a.userId, id, b.name);
  }

  @Patch('files/:id/parent')
  move(@Auth() a: AuthContext, @Param('id') id: string, @Body(new ZodPipe(MoveSchema)) b: z.infer<typeof MoveSchema>) {
    return this.files.move(a.userId, id, b.parentId);
  }

  /** Moves to Trash (recoverable for 30 days). */
  @Delete('files/:id')
  trash(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.files.trash(a.userId, id);
  }

  @Get('files/:id/download')
  download(@Auth() a: AuthContext, @Param('id') id: string, @Query(new ZodPipe(InlineSchema)) q: z.infer<typeof InlineSchema>) {
    return this.files.downloadUrl(a.userId, id, q.inline === '1');
  }

  @Get('files/:id/thumbnail')
  thumbnail(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.files.thumbnailUrl(a.userId, id);
  }

  @Get('files/:id/versions')
  versions(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.files.versions(a.userId, id);
  }

  @HttpCode(200)
  @Post('files/:id/versions/:versionId/restore')
  restoreVersion(@Auth() a: AuthContext, @Param('id') id: string, @Param('versionId') versionId: string) {
    return this.files.restoreVersion(a.userId, id, versionId);
  }

  @Delete('files/:id/versions/:versionId')
  deleteVersion(@Auth() a: AuthContext, @Param('id') id: string, @Param('versionId') versionId: string) {
    return this.files.deleteVersion(a.userId, id, versionId);
  }

  // ----- trash -----
  @Get('trash')
  listTrash(@Auth() a: AuthContext) {
    return this.files.listTrash(a.userId);
  }

  @HttpCode(200)
  @Post('trash/:id/restore')
  restore(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.files.restore(a.userId, id);
  }

  @Delete('trash/:id')
  deleteForever(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.files.deleteForever(a.userId, id);
  }

  @Delete('trash')
  emptyTrash(@Auth() a: AuthContext) {
    return this.files.emptyTrash(a.userId);
  }
}
