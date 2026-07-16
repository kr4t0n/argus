import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectService } from './project.service';

/**
 * Body of PATCH /projects/icon. Projects have no id of their own, so
 * the (machineId, workingDir) pair rides in the body. Like the machine
 * variant, `iconKey` is validated for length but not membership (the
 * catalog — A-Z letters today — is a frontend concern, so adding a new
 * glyph never requires a server deploy). Pass `null` to reset to the
 * default.
 */
class SetProjectIconDto {
  @IsString()
  @MaxLength(64)
  machineId!: string;

  @IsString()
  @MaxLength(1024)
  workingDir!: string;

  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  iconKey!: string | null;
}

class CreateProjectDto {
  @IsString()
  @MaxLength(64)
  machineId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  workingDir!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsBoolean()
  supportsTerminal?: boolean;
}

class RenameProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}

/** Snapshot of what the client-side archive cascade actually flipped.
 *  Both arrays optional as a pair — a legacy broad archive omits them. */
class ArchiveProjectDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  archivedAgentIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  archivedSessionIds?: string[];
}

@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectController {
  constructor(private readonly service: ProjectService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(@Body() body: CreateProjectDto) {
    return this.service.create(body);
  }

  @Patch('icon')
  setIcon(@Body() body: SetProjectIconDto) {
    return this.service.setIcon(body.machineId, body.workingDir, body.iconKey);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: RenameProjectDto) {
    return this.service.rename(id, body.name);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string, @Body() body: ArchiveProjectDto) {
    const snapshot =
      body.archivedAgentIds !== undefined && body.archivedSessionIds !== undefined
        ? {
            archivedAgentIds: body.archivedAgentIds,
            archivedSessionIds: body.archivedSessionIds,
          }
        : undefined;
    return this.service.archive(id, snapshot);
  }

  @Post(':id/unarchive')
  unarchive(@Param('id') id: string) {
    return this.service.unarchive(id);
  }
}
