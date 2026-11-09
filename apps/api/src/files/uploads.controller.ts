import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { UploadCompleteSchema, UploadInitSchema, UploadPartsSchema } from '@maxcloud/shared';
import { Auth, type AuthContext } from '../common/auth.guard';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { UploadsService } from './uploads.service';

@Controller('uploads')
export class UploadsController {
  constructor(private uploads: UploadsService) {}

  @RateLimit({ limit: 600, windowSec: 60, bucket: 'upload-init' })
  @Post()
  init(@Auth() a: AuthContext, @Body(new ZodPipe(UploadInitSchema)) b: z.infer<typeof UploadInitSchema>) {
    return this.uploads.init(a.userId, b);
  }

  @Get()
  pending(@Auth() a: AuthContext) {
    return this.uploads.listPending(a.userId);
  }

  @Get(':id')
  status(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.uploads.status(a.userId, id);
  }

  @HttpCode(200)
  @RateLimit({ limit: 3000, windowSec: 60, bucket: 'upload-parts' })
  @Post(':id/parts')
  parts(@Auth() a: AuthContext, @Param('id') id: string, @Body(new ZodPipe(UploadPartsSchema)) b: z.infer<typeof UploadPartsSchema>) {
    return this.uploads.presignParts(a.userId, id, b.partNumbers);
  }

  @HttpCode(200)
  @Post(':id/complete')
  complete(@Auth() a: AuthContext, @Param('id') id: string, @Body(new ZodPipe(UploadCompleteSchema)) b: z.infer<typeof UploadCompleteSchema>) {
    return this.uploads.complete(a.userId, id, b.parts);
  }

  @Delete(':id')
  abort(@Auth() a: AuthContext, @Param('id') id: string) {
    return this.uploads.abort(a.userId, id);
  }
}
