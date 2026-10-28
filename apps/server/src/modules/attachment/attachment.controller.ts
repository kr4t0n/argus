import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AttachmentService } from './attachment.service';

type AuthedRequest = Request & { user: { id: string } };

// Hard memory guard for the multipart parser, read at import time. The
// service re-checks against the (config-driven) limit for a clean 413;
// this just stops multer buffering an unbounded body into memory.
const MAX_FILE_BYTES = Number(process.env.ATTACHMENT_MAX_FILE_BYTES) || 26_214_400;

// Browsers, OkHttp and the iOS client all send the part's `filename` as raw
// UTF-8, and multer decodes it as latin1 unless told otherwise, which stored
// every non-ASCII name as mojibake. `defParamCharset` arrived in multer 2.1;
// Nest 10's MulterOptions type predates it, but FileInterceptor hands the
// whole object to multer, so it rides along through this typed constant.
const UPLOAD_OPTIONS: NonNullable<Parameters<typeof FileInterceptor>[1]> & {
  defParamCharset: string;
} = {
  limits: { fileSize: MAX_FILE_BYTES },
  defParamCharset: 'utf8',
};

@Controller('attachments')
export class AttachmentController {
  constructor(private readonly attachments: AttachmentService) {}

  /** Upload a single file. The dashboard calls this once per file as the
   *  user attaches them, then sends the returned ids with the prompt. */
  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(FileInterceptor('file', UPLOAD_OPTIONS))
  async upload(@Req() req: AuthedRequest, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('no file provided (form field "file")');
    return this.attachments.upload(req.user.id, file);
  }

  /**
   * Stream an attachment's bytes. Deliberately NOT behind JwtAuthGuard:
   * the sidecar has no user JWT, and <img> tags can't send an
   * Authorization header — both authenticate with the short-lived signed
   * token in `t` instead, which the service verifies.
   */
  @Get(':id')
  async download(
    @Param('id') id: string,
    @Query('t') token: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.attachments.streamDownload(id, token ?? '', res);
  }
}
