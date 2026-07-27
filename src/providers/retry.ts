export type RetryOptions = {
  /** Total attempts before giving up (default 4). */
  attempts?: number;
  /** Base backoff in ms; attempt N waits `base * N` (default 500). */
  baseMs?: number;
  /** Sleep implementation, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Run `fn`, retrying on any thrown error with linear backoff. Vault reads over a
 * network (or a CLI subprocess) fail transiently often enough in CI that a bare
 * single attempt is flaky; this bounds the retries and re-throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T> | T,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseMs = options.baseMs ?? 500;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(baseMs * attempt);
    }
  }
  throw lastError;
}
