import { Catch, Logger, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { describeError, errorStack } from './describe-error';

/**
 * Nest's default handler logs `exception.message` — and falls back to
 * logging the raw object when that message is empty. Node's connect-path
 * `AggregateError` has an EMPTY message and keeps the real errnos in
 * `.errors`, so the default handler prints exactly
 * `ERROR [ExceptionsHandler] AggregateError` with no stack and no cause —
 * the least actionable log line in the system.
 *
 * This filter changes only the LOGGING: it flattens such errors into one
 * line carrying every sub-reason, then delegates to the base filter so the
 * HTTP response shape is untouched (HttpExceptions pass straight through).
 * The base filter then logs the original line too — the duplicate is
 * deliberate: it keeps the default breadcrumb intact rather than
 * reimplementing `BaseExceptionFilter`'s response handling to suppress it.
 *
 * HTTP only. `@nestjs/websockets` builds its gateway filter chain from
 * `ExceptionFiltersContext`, whose `getGlobalMetadata()` returns `[]`, so
 * globals registered here never reach `StreamGateway`/`TerminalGateway` —
 * which matters, because `BaseExceptionFilter` assumes an HTTP response
 * object at `host.getArgByIndex(1)`.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private static readonly log = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (isOpaque(exception)) {
      AllExceptionsFilter.log.error(describeError(exception), errorStack(exception));
    }
    super.catch(exception, host);
  }
}

/** Errors the base filter cannot log usefully: no message of their own. */
function isOpaque(err: unknown): boolean {
  return err instanceof AggregateError || (err instanceof Error && !err.message);
}
