import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { Request } from 'express';
import type { PixelsResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PixelsService } from './pixels.service';

type AuthedRequest = Request & { user: { id: string } };

/** Slot sizes that divide a day evenly. An uneven size would make the
 *  last slot of each local day a stub, so every column of a day×hour
 *  layout would drift. */
const SLOT_SIZES = [5, 10, 15, 20, 30, 60, 120, 240];

/** Upper bound on cells in one response. The query cost is independent of
 *  grid size (it scales with commands, not slots), so this exists to
 *  bound the PAYLOAD and the client's DOM, not the database. */
const MAX_SLOTS = 4000;

class PixelsQueryDto {
  /**
   * IANA zone the grid is bucketed in. Defaults to UTC, but pass your
   * real zone: with hour-of-day as an axis the choice is load-bearing —
   * bucketing in the wrong zone rotates the whole grid by the offset,
   * which looks plausible rather than broken.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  days?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(SLOT_SIZES)
  slotMinutes?: number;

  /** Cap on one turn's contribution. See `PixelGridOptions.clampMinutes`
   *  — this changes the picture, it isn't just hygiene. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  clampMinutes?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  breakdown?: boolean;
}

/**
 * Time-sliced activity wall: one cell per slot, coloured by whichever
 * project was busiest in it, plus the set of projects with a turn in
 * flight right now.
 *
 * Aggregates only — no titles, prompts, or paths — so the payload is safe
 * to re-serve from a public surface. It is still an authenticated route:
 * a public page should reach it through a backend that holds the
 * credential, not by shipping one to the browser, where it would be
 * readable in view-source and would carry access to every other GET in
 * the API (the `readonly` API-key flag is scoped by HTTP method, not by
 * resource).
 */
@UseGuards(JwtAuthGuard)
@Controller('me/pixels')
export class PixelsController {
  constructor(private readonly pixels: PixelsService) {}

  @Get()
  grid(@Req() req: AuthedRequest, @Query() q: PixelsQueryDto): Promise<PixelsResponse> {
    const tz = q.tz?.trim() || 'UTC';
    assertTimeZone(tz);

    const days = q.days ?? 42;
    const slotMinutes = q.slotMinutes ?? 60;
    const slots = Math.ceil((days * 24 * 60) / slotMinutes);
    if (slots > MAX_SLOTS) {
      throw new BadRequestException(
        `${slots} slots exceeds the ${MAX_SLOTS} cap — widen slotMinutes or shorten days`,
      );
    }

    return this.pixels.grid(req.user.id, {
      tz,
      days,
      slotMinutes,
      clampMinutes: q.clampMinutes ?? 60,
      breakdown: q.breakdown ?? false,
    });
  }
}

/**
 * Reject an unknown zone here rather than letting Postgres raise on
 * `AT TIME ZONE`, which surfaces as an opaque 500. The zone reaches the
 * query as a bound parameter, so this is about the error message, not
 * injection.
 */
function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new BadRequestException(`unknown time zone "${tz}" (expected an IANA name)`);
  }
}
