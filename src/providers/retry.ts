export type RetryOptions = {
  /** Total attempts before giving up (default 4). */
  attempts?: number;
  /** Base backoff in ms; attempt N waits `base * N` (default 500). */
  baseMs?: number;
  /** Sleep implementation, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Whether an error is worth another attempt. Defaults to retrying everything.
   * Return `false` for failures a retry cannot fix and should not pay for — a
   * metered rate limit, an expired session — so they surface on the first one.
   */
  shouldRetry?: (error: unknown) => boolean;
};

/**
 * Run `fn`, retrying on a thrown error with linear backoff. Vault reads over a
 * network (or a CLI subprocess) fail transiently often enough in CI that a bare
 * single attempt is flaky; this bounds the retries and re-throws the last error.
 *
 * {@link RetryOptions.shouldRetry} opts an error out of that: retrying a request
 * the backend already refused can make things worse where the backend meters
 * requests rather than concurrency.
 */
export async function withRetry<T>(
  fn: () => Promise<T> | T,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseMs = options.baseMs ?? 500;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) break;
      if (attempt < attempts) await sleep(baseMs * attempt);
    }
  }
  throw lastError;
}
