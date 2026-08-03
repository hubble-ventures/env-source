import { spawnSync } from "node:child_process";
import type { Provider } from "../core/types.js";
import { type RetryOptions, withRetry } from "./retry.js";

const DEFAULT_API_URL = "https://app.infisical.com";
// Bound every request so a hung vault can't stall a CI job up to undici's 300s
// default; the caller (or the job timeout) handles a genuine outage.
const REQUEST_TIMEOUT_MS = 30_000;

// Least privilege is the point, and the two lanes buy it differently.
//
// The REST lane (CI) fetches one key per request from `/secrets/raw/{key}`, a
// genuine single-secret endpoint: only the declared keys ever cross the wire.
//
// The CLI lane cannot do that. `infisical secrets get <KEY> --path=P` resolves
// server-side to `GET /secrets/raw?secretPath=P` — the *folder* endpoint, with
// no key filter — and filters the answer client-side. Asking per key therefore
// downloads the whole folder once per key instead of once, which is how a pull
// of 74 declared keys became 74 full-folder requests and a 429. So this lane
// reads each folder once and selects the declared keys from it: strictly less
// data over the wire than asking per key, and identical downstream — only
// declared keys are ever returned, and an absent key stays absent.

// ---------------------------------------------------------------------------
// CI lane — REST over GitHub OIDC
// ---------------------------------------------------------------------------

export type InfisicalApiOptions = {
  /** Bearer token (minted from GitHub OIDC). */
  token: string;
  /** Infisical project slug the secrets live in. */
  project: string;
  /** API base URL (env `INFISICAL_API_URL` → cloud default). */
  baseUrl?: string;
  /** Retry policy for transient read failures. */
  retry?: RetryOptions;
};

/**
 * {@link Provider} backed by the Infisical REST API, using the platform's native
 * `fetch`. This is the CI lane: authenticate with {@link loginWithOidc}, which
 * exchanges a GitHub OIDC JWT for a short-lived token — no long-lived credential
 * is stored. Each key is fetched individually (with reference expansion) so only
 * the declared secrets cross the wire.
 */
export class InfisicalApiProvider implements Provider {
  readonly id = "infisical";
  private readonly token: string;
  private readonly project: string;
  private readonly baseUrl: string;
  private readonly retry: RetryOptions;

  constructor(options: InfisicalApiOptions) {
    this.token = options.token;
    this.project = options.project;
    this.baseUrl = options.baseUrl ?? DEFAULT_API_URL;
    this.retry = options.retry ?? {};
  }

  /** Exchange a GitHub OIDC JWT for an Infisical access token via a machine identity. */
  static async loginWithOidc(params: {
    identityId: string;
    jwt: string;
    project: string;
    baseUrl?: string;
  }): Promise<InfisicalApiProvider> {
    const baseUrl = params.baseUrl ?? DEFAULT_API_URL;
    const res = await withRetry(() =>
      fetchOk(`${baseUrl}/api/v1/auth/oidc-auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityId: params.identityId, jwt: params.jwt }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    );
    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) {
      throw new Error("Infisical OIDC login returned no accessToken");
    }
    return new InfisicalApiProvider({
      token: data.accessToken,
      project: params.project,
      baseUrl,
    });
  }

  async read(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        const value = await this.getSecret(environment, path, key);
        if (value !== undefined) out[key] = value;
      })
    );
    return out;
  }

  async peek(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Set<string>> {
    const present = new Set<string>();
    await Promise.all(
      keys.map(async (key) => {
        // Existence only: we check the status and never parse the value body.
        if (await this.hasSecret(environment, path, key)) present.add(key);
      })
    );
    return present;
  }

  /** Fetch one secret's value, or `undefined` when it does not exist (404). */
  private getSecret(
    environment: string,
    path: string,
    key: string
  ): Promise<string | undefined> {
    return withRetry(async () => {
      const res = await fetch(this.secretUrl(environment, path, key), {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) return undefined;
      if (!res.ok) {
        throw new Error(
          `Infisical read failed for ${path}:${key} (${res.status}): ${await res.text()}`
        );
      }
      const data = (await res.json()) as { secret: { secretValue: string } };
      return data.secret.secretValue;
    }, this.retry);
  }

  /** Assert one secret exists without parsing its value. */
  private hasSecret(
    environment: string,
    path: string,
    key: string
  ): Promise<boolean> {
    return withRetry(async () => {
      const res = await fetch(this.secretUrl(environment, path, key), {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) return false;
      if (!res.ok) {
        throw new Error(
          `Infisical peek failed for ${path}:${key} (${res.status}): ${await res.text()}`
        );
      }
      return true;
    }, this.retry);
  }

  private secretUrl(environment: string, path: string, key: string): URL {
    const url = new URL(
      `${this.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(key)}`
    );
    url.searchParams.set("workspaceSlug", this.project);
    url.searchParams.set("environment", environment);
    url.searchParams.set("secretPath", path);
    // Resolve `${REF}` references and follow imports server-side, but still fetch
    // only this one declared key by name.
    url.searchParams.set("expandSecretReferences", "true");
    url.searchParams.set("include_imports", "true");
    return url;
  }
}

// ---------------------------------------------------------------------------
// Local lane — the Infisical CLI (uses the developer's own login session)
// ---------------------------------------------------------------------------

export type SpawnResult = { status: number | null; stdout: string; stderr: string };
export type SpawnFn = (command: string, args: string[]) => SpawnResult;

// A folder export is unbounded where a single secret was not, and Node caps
// captured stdout at 1 MiB by default — past which spawnSync kills the child,
// truncates stdout and reports ENOBUFS, costing a full retry cycle before it
// fails with a message about the CLI rather than about size. Lift the ceiling
// well past any plausible folder instead.
const SPAWN_MAX_BUFFER = 64 * 1024 * 1024;

const defaultSpawn: SpawnFn = (command, args) => {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
};

// Distinguish "this key isn't there" (fine — omit it) from a real failure such as
// not being logged in or a network error (must surface, not be read as absent).
const NOT_FOUND = /not found|does not exist|no secret|secret .* not found/i;

export type InfisicalCliOptions = {
  /** Infisical project id (UUID) the CLI reads. */
  projectId: string;
  /** Injectable spawn, for tests. */
  spawn?: SpawnFn;
  /** Retry policy for transient CLI failures. */
  retry?: RetryOptions;
};

/**
 * {@link Provider} backed by the Infisical CLI. This is the local lane: it shells
 * out to `infisical export`, which uses the developer's own authenticated session
 * (`infisical login`, stored in the OS keyring) — env-source never handles a
 * token. One invocation per folder, from which the declared keys are selected;
 * see the note at the top of this file for why per-key is not the cheaper or the
 * more private option here.
 */
export class InfisicalCliProvider implements Provider {
  readonly id = "infisical";
  private readonly projectId: string;
  private readonly spawn: SpawnFn;
  private readonly retry: RetryOptions;
  /**
   * In-flight and completed folder reads, keyed by environment + path. `validate`
   * peeks and pulls the same folder, and manifests routinely share one; caching
   * the promise (not just the result) also collapses concurrent callers into a
   * single request.
   */
  private readonly folders = new Map<string, Promise<Record<string, string>>>();

  constructor(options: InfisicalCliOptions) {
    this.projectId = options.projectId;
    this.spawn = options.spawn ?? defaultSpawn;
    this.retry = options.retry ?? {};
  }

  async read(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Record<string, string>> {
    const folder = await this.readFolder(environment, path);
    const out: Record<string, string> = {};
    for (const key of keys) {
      // Only declared keys are returned; anything else the folder holds is
      // dropped here and never reaches a manifest or an output file.
      if (Object.hasOwn(folder, key)) out[key] = folder[key] as string;
    }
    return out;
  }

  async peek(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Set<string>> {
    const folder = await this.readFolder(environment, path);
    return new Set(keys.filter((key) => Object.hasOwn(folder, key)));
  }

  /** Every secret in one folder, read once per (environment, path). */
  private readFolder(
    environment: string,
    path: string
  ): Promise<Record<string, string>> {
    const cacheKey = `${environment}\0${path}`;
    const cached = this.folders.get(cacheKey);
    if (cached) return cached;
    // Drop a failed read from the cache so a later call retries rather than
    // replaying the failure — a CLI run aborts on it either way, but a
    // long-lived library consumer holding one provider should recover.
    const pending = this.exportFolder(environment, path).catch((error) => {
      this.folders.delete(cacheKey);
      throw error;
    });
    this.folders.set(cacheKey, pending);
    return pending;
  }

  private exportFolder(
    environment: string,
    path: string
  ): Promise<Record<string, string>> {
    return withRetry(() => {
      const result = this.spawn("infisical", [
        "export",
        "--format=json",
        `--projectId=${this.projectId}`,
        `--env=${environment}`,
        `--path=${path}`,
        // Match the per-key call this replaces: expand `${REF}` references and
        // follow imports server-side.
        "--expand=true",
        "--include-imports=true",
        // Keep tip/update notices off stdout so the JSON always parses.
        "--silent",
      ]);
      if (result.status === 0) return parseExport(result.stdout);
      const detail = (result.stderr || result.stdout).trim();
      // An absent folder is an absent key by every caller's reckoning, which is
      // what asking per key already reported. A real failure still surfaces.
      if (NOT_FOUND.test(detail)) return {};
      throw new Error(
        `infisical export failed for ${path} (${environment}): ${detail || "is the Infisical CLI installed and are you logged in? (`infisical login`)"}`
      );
    }, this.retry);
  }
}

/**
 * Parse `infisical export --format=json`: an array of secret records carrying at
 * least `key` and `value`. Malformed output throws so {@link withRetry} can try
 * again — truncated stdout is exactly the transient failure retries are for, and
 * silently reading it as an empty folder would report every declared key absent.
 */
function parseExport(stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("infisical export returned output that is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("infisical export returned JSON that is not an array");
  }
  const out: Record<string, string> = {};
  for (const entry of parsed as { key?: unknown; value?: unknown }[]) {
    if (typeof entry?.key === "string" && typeof entry.value === "string") {
      out[entry.key] = entry.value;
    }
  }
  return out;
}

/** Whether the Infisical CLI is available on PATH. */
export function infisicalCliAvailable(spawn: SpawnFn = defaultSpawn): boolean {
  return spawn("infisical", ["--version"]).status === 0;
}

async function fetchOk(
  input: string | URL,
  init: RequestInit
): Promise<Response> {
  const res = await fetch(input, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res;
}
