/**
 * Error-flattening shared by the global exception filter and any service
 * that logs a caught error.
 *
 * Two shapes print as nothing useful on their own:
 *   - `AggregateError` — its own `message` is the EMPTY string and the real
 *     errnos hide in `.errors`. Node's happy-eyeballs connect path
 *     (`autoSelectFamily`, default-on since Node 20) throws exactly this
 *     when every resolved address of a target refuses.
 *   - `cause` chains — the outer error names a layer, the inner one names
 *     the actual failure.
 */

/** Depth cap so a self-referential `cause`/`errors` graph can't blow the
 *  stack — this code runs *inside* the exception filter, which is the worst
 *  possible place to throw. */
const MAX_DEPTH = 8;

/** One line carrying the class, errno, message and every nested reason. */
export function describeError(err: unknown, depth = 0): string {
  if (depth >= MAX_DEPTH) return '…';
  if (err instanceof AggregateError) {
    const reasons = err.errors.map((e) => describeError(e, depth + 1)).join('; ');
    return `AggregateError(${err.errors.length} reasons): ${reasons || err.message || '<none>'}`;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const head = `${err.name}${code ? `[${code}]` : ''}${err.message ? `: ${err.message}` : ''}`;
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${head} <- ${describeError(cause, depth + 1)}` : head;
  }
  return String(err);
}

/** An AggregateError's own stack points at the aggregator, not the failure —
 *  prefer the first sub-error's stack when there is one. */
export function errorStack(err: unknown): string | undefined {
  if (err instanceof AggregateError) {
    const first = err.errors.find((e): e is Error => e instanceof Error);
    return first?.stack ?? err.stack;
  }
  return err instanceof Error ? err.stack : undefined;
}
