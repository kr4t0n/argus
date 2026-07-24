import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Response } from 'express';
import type { Attachment as PAttachment } from '@prisma/client';
import type { AttachmentDTO, AttachmentRef } from '@argus/shared-types';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { describeError } from '../../common/describe-error';
import { S3_CLIENT } from './s3.provider';

/** JWT `scope` claim that marks a token as an attachment-download grant —
 *  distinct from auth tokens (which carry a real user `sub`), so one can
 *  never be used in place of the other. */
const DOWNLOAD_SCOPE = 'attachment-download';
/** Pull tokens handed to the sidecar are short-lived: they only need to
 *  survive the brief window between dispatch and the sidecar's HTTP GET. */
const PULL_TOKEN_TTL = '15m';
/** Display tokens embedded in DTO urls for the browser's <img>/links —
 *  longer so a transcript stays viewable for a while without a refetch. */
const DISPLAY_TOKEN_TTL = '1h';

interface DownloadClaims {
  sub: string;
  scope: string;
}

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);
  private readonly bucket: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    @Inject(S3_CLIENT) private readonly s3: S3Client | null,
  ) {
    this.bucket = this.config.get<string>('S3_BUCKET', 'argus-attachments');
    this.maxBytes = Number(this.config.get('ATTACHMENT_MAX_FILE_BYTES', 26_214_400));
    this.maxFiles = Number(this.config.get('ATTACHMENT_MAX_FILES', 10));
  }

  /**
   * Store one uploaded file in S3 and record its metadata. The row is
   * created unlinked (`commandId = null`); the dispatch path links it to
   * a command once the turn is actually sent. Puts to S3 first, then
   * writes the row — on a DB failure we best-effort delete the object so
   * we don't strand bytes with no metadata pointing at them.
   */
  async upload(
    userId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<AttachmentDTO> {
    if (!file.buffer || file.size === 0) {
      throw new BadRequestException('empty file');
    }
    if (file.size > this.maxBytes) {
      throw new PayloadTooLargeException(
        `file exceeds the ${Math.floor(this.maxBytes / 1_048_576)} MiB limit`,
      );
    }

    const filename = sanitizeFilename(file.originalname);
    const key = `attachments/${randomUUID()}/${filename}`;

    await this.sendToStore(
      (s3) =>
        s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype || 'application/octet-stream',
            ContentLength: file.size,
          }),
        ),
      `upload ${key}`,
    );

    try {
      const row = await this.prisma.attachment.create({
        data: {
          userId,
          filename,
          mime: file.mimetype || 'application/octet-stream',
          size: file.size,
          s3Key: key,
        },
      });
      return await this.toDto(row);
    } catch (err) {
      await this.deleteObject(key);
      throw err;
    }
  }

  /**
   * Validate + link previously-uploaded attachments to a freshly-created
   * command, and return the wire refs (with short-lived pull tokens) for
   * the sidecar. Rejects ids that aren't the caller's, are already linked,
   * or push the turn over the per-turn file cap. Returns [] for no ids.
   */
  async linkAndBuildRefs(
    userId: string,
    attachmentIds: string[] | undefined,
    commandId: string,
  ): Promise<AttachmentRef[]> {
    if (!attachmentIds || attachmentIds.length === 0) return [];
    if (attachmentIds.length > this.maxFiles) {
      throw new BadRequestException(`at most ${this.maxFiles} files per message`);
    }
    const ids = [...new Set(attachmentIds)];

    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, userId, commandId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length !== ids.length) {
      throw new BadRequestException('one or more attachments are invalid or already used');
    }

    await this.prisma.attachment.updateMany({
      where: { id: { in: ids } },
      data: { commandId },
    });

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        size: row.size,
        token: await this.mintToken(row.id, PULL_TOKEN_TTL),
      })),
    );
  }

  /** All attachments linked to a command, as DTOs (with display urls).
   *  Used by the dispatch path so the just-sent turn shows its files. */
  async dtosForCommand(commandId: string): Promise<AttachmentDTO[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { commandId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  /**
   * Batch variant: attachments for many commands at once, grouped by
   * commandId. One query feeds a whole session's transcript without an
   * N+1 — commands with no attachments simply don't appear in the map.
   */
  async dtosByCommand(commandIds: string[]): Promise<Map<string, AttachmentDTO[]>> {
    const map = new Map<string, AttachmentDTO[]>();
    if (commandIds.length === 0) return map;
    const rows = await this.prisma.attachment.findMany({
      where: { commandId: { in: commandIds } },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      if (!row.commandId) continue;
      const dto = await this.toDto(row);
      const arr = map.get(row.commandId);
      if (arr) arr.push(dto);
      else map.set(row.commandId, [dto]);
    }
    return map;
  }

  /**
   * Verify the signed token, then stream the object from S3 to the HTTP
   * response. Serves BOTH the sidecar's pull and the browser's <img>/
   * download — same endpoint, same token scheme. Throws (handled by Nest
   * before any bytes are written) on a bad/expired token or missing row.
   */
  async streamDownload(id: string, token: string, res: Response): Promise<void> {
    await this.verifyToken(id, token);

    const row = await this.prisma.attachment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('attachment not found');

    const obj = await this.sendToStore(
      (s3) => s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: row.s3Key })),
      `download ${row.s3Key}`,
    );
    const body = obj.Body as Readable | undefined;
    if (!body) throw new NotFoundException('attachment body missing');

    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', row.size);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${sanitizeFilename(row.filename)}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=3600');

    body.on('error', (err) => {
      this.logger.warn(`stream error for attachment ${id}: ${err.message}`);
      res.destroy(err);
    });
    body.pipe(res);
  }

  private async toDto(row: PAttachment): Promise<AttachmentDTO> {
    const token = await this.mintToken(row.id, DISPLAY_TOKEN_TTL);
    return {
      id: row.id,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      url: `/attachments/${row.id}?t=${token}`,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private mintToken(attachmentId: string, expiresIn: string): Promise<string> {
    return this.jwt.signAsync({ sub: attachmentId, scope: DOWNLOAD_SCOPE }, { expiresIn });
  }

  private async verifyToken(attachmentId: string, token: string): Promise<void> {
    if (!token) throw new UnauthorizedException('missing token');
    let claims: DownloadClaims;
    try {
      claims = await this.jwt.verifyAsync<DownloadClaims>(token);
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
    if (claims.scope !== DOWNLOAD_SCOPE || claims.sub !== attachmentId) {
      throw new UnauthorizedException('token does not grant this attachment');
    }
  }

  private async deleteObject(key: string): Promise<void> {
    if (!this.s3) return;
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      this.logger.warn(`failed to delete orphaned object ${key}: ${describeError(err)}`);
    }
  }

  /**
   * Run one S3 operation with the object store's failure modes made
   * legible. Without this, an unreachable endpoint surfaces as Node's
   * connect `AggregateError` — whose `message` is EMPTY, so Nest's default
   * handler logs the bare string `AggregateError` with no stack and no
   * cause, and the user gets an unexplained 500.
   *
   * A vanished object is a 404 (the row outlived its bytes — see the S3
   * orphan-sweep TODO); everything else is a 503 whose text separates "not
   * configured" from "unreachable" from "rejected". The operator-facing
   * detail (endpoint, bucket, per-address errno) goes to the log only.
   */
  private async sendToStore<T>(op: (s3: S3Client) => Promise<T>, what: string): Promise<T> {
    if (!this.s3) {
      this.logger.error(`cannot ${what}: S3_ENDPOINT is not configured`);
      throw new ServiceUnavailableException(
        'file attachments are not configured on this server',
      );
    }
    try {
      return await op(this.s3);
    } catch (err) {
      if (isMissingObject(err)) {
        this.logger.warn(`object store ${what}: object is gone (bucket=${this.bucket})`);
        throw new NotFoundException('attachment is no longer stored');
      }
      const endpoint = this.config.get<string>('S3_ENDPOINT', '(unset)');
      this.logger.error(
        `object store ${what} failed (endpoint=${endpoint} bucket=${this.bucket}): ${describeError(err)}`,
      );
      throw new ServiceUnavailableException(
        isConnectFailure(err)
          ? 'attachment storage is unreachable — check the server logs'
          : 'attachment storage rejected the request — check the server logs',
      );
    }
  }
}

/** True when S3 says the *object* isn't there. Deliberately keyed on the
 *  error name rather than the 404 status: `NoSuchBucket` is also a 404 but
 *  means the deployment is misconfigured, which is a 503, not a missing
 *  attachment. `NoSuchKey` is GetObject's form, `NotFound` HeadObject's. */
function isMissingObject(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NoSuchKey' || err.name === 'NotFound');
}

/** True when the failure is "never reached the endpoint" rather than an S3
 *  API error. Node's happy-eyeballs connect wraps the per-address errnos in
 *  an AggregateError, which is exactly the unreachable-MinIO case.
 *  ECONNRESET is NOT here on purpose — a reset means we did reach the
 *  endpoint, so "unreachable" would point the operator at the wrong thing. */
function isConnectFailure(err: unknown): boolean {
  if (err instanceof AggregateError) return true;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (
    code &&
    ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code)
  ) {
    return true;
  }
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  return cause ? isConnectFailure(cause) : false;
}

/** Strip path separators / control chars and bound the length so a
 *  client-supplied name can't escape a directory or break headers.
 *  Falls back to a generic name when nothing usable remains. */
function sanitizeFilename(name: string): string {
  const base = (name || '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f"]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}
