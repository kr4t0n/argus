import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, ValidateIf } from 'class-validator';
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

@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectController {
  constructor(private readonly service: ProjectService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Patch('icon')
  setIcon(@Body() body: SetProjectIconDto) {
    return this.service.setIcon(body.machineId, body.workingDir, body.iconKey);
  }
}
