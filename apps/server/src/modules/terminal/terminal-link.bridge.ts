import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { SidecarLinkFrame, TerminalOutput, TerminalClosed } from '@argus/shared-types';
import { SidecarLinkService } from '../sidecar-link/sidecar-link.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { TerminalService } from './terminal.service';

/**
 * Bridges inbound sidecar-link frames to the TerminalService + WS
 * gateway. Lives in the terminal module so the link module can stay
 * agnostic of the domain (it just ferries JSON frames).
 *
 * On sidecar disconnect we force-close that sidecar's open terminals
 * so the UI doesn't show zombie sessions. Rationale: when the link
 * drops we have no way to verify the PTY is still alive; the sidecar
 * could have crashed, been killed, or lost network. Closing on the
 * server side is safe because any re-open after reconnect is a new
 * terminal with a new id.
 */
@Injectable()
export class TerminalLinkBridge implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TerminalLinkBridge.name);
  private offFrame?: () => void;
  private offDisconnect?: () => void;

  constructor(
    private readonly link: SidecarLinkService,
    private readonly terminals: TerminalService,
    private readonly gateway: StreamGateway,
  ) {}

  onApplicationBootstrap() {
    this.offFrame = this.link.onFrame((sidecarId, frame) =>
      this.handleFrame(sidecarId, frame),
    );
    this.offDisconnect = this.link.onDisconnect((sidecarId, reason) =>
      this.handleDisconnect(sidecarId, reason),
    );
  }

  onModuleDestroy() {
    this.offFrame?.();
    this.offDisconnect?.();
  }

  private handleFrame(sidecarId: string, frame: SidecarLinkFrame) {
    const kind = (frame as { kind?: string }).kind;
    if (kind === 'terminal-output') {
      const f = frame as TerminalOutput;
      // Fast path: ship to WS clients first; housekeeping after. The
      // hot subscriber (xterm.js) only cares about the data, and the
      // status update is strictly cosmetic.
      this.gateway.emitTerminalOutput({
        terminalId: f.terminalId,
        seq: f.seq,
        data: f.data,
      });
      this.terminals.markOpenIfNeeded(f.terminalId).catch(() => {});
      return;
    }
    if (kind === 'terminal-closed') {
      const f = frame as TerminalClosed;
      this.terminals
        .markClosed(f.terminalId, f.exitCode, f.reason)
        .catch((err) =>
          this.logger.warn(
            `markClosed failed for ${f.terminalId}: ${(err as Error).message}`,
          ),
        );
      return;
    }
    // We don't expect server-bound `terminal-open/input/resize/close`
    // from a sidecar; log and ignore.
    this.logger.warn(`unexpected frame kind=${kind} from sidecar ${sidecarId}`);
  }

  private handleDisconnect(sidecarId: string, reason: string) {
    // sidecarId == machineId in the new architecture: the daemon
    // identifies itself by machine id when dialing the link, and the
    // server keys connections by that same id.
    this.terminals
      .markAllForMachineClosed(sidecarId, `link disconnected: ${reason}`)
      .catch((err) =>
        this.logger.warn(
          `markAllForMachineClosed failed for ${sidecarId}: ${(err as Error).message}`,
        ),
      );
  }
}
