import { spawnSync } from "node:child_process";
import type { Provider } from "../core/types.js";
import { type RetryOptions, withRetry } from "./retry.js";

const DEFAULT_API_URL = "https://app.infisical.com";
// Bound every request so a hung vault can't stall a CI job up to undici's 300s
// default; the caller (or the job timeout) handles a genuine outage.
const REQUEST_TIMEOUT_MS = 30_000;

// Least privilege is the whole point: every read and peek fetches exactly the
// keys the manifest declares, one request per key, and nothing else. We never
// list or export a folder — an env-source consumer only ever pulls the keys and
// values it explicitly named.

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

const defaultSpawn: SpawnFn = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8" });
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
 * out to `infisical secrets get <KEY>`, which uses the developer's own
 * authenticated session (`infisical login`, stored in the OS keyring) —
 * env-source never handles a token. One invocation per declared key, so only the
 * named secrets are ever requested.
 */
export class InfisicalCliProvider implements Provider {
  readonly id = "infisical";
  private readonly projectId: string;
  private readonly spawn: SpawnFn;
  private readonly retry: RetryOptions;

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
        if ((await this.getSecret(environment, path, key)) !== undefined) {
          present.add(key);
        }
      })
    );
    return present;
  }

  /** Read one secret via the CLI, or `undefined` when it does not exist. */
  private getSecret(
    environment: string,
    path: string,
    key: string
  ): Promise<string | undefined> {
    return withRetry(() => {
      const result = this.spawn("infisical", [
        "secrets",
        "get",
        key,
        `--projectId=${this.projectId}`,
        `--env=${environment}`,
        `--path=${path}`,
        "--plain",
        "--silent",
      ]);
      if (result.status === 0) return result.stdout.replace(/\n$/, "");
      const detail = (result.stderr || result.stdout).trim();
      if (NOT_FOUND.test(detail)) return undefined; // absent — not an error
      throw new Error(
        `infisical secrets get failed for ${path}:${key} (${environment}): ${detail || "is the Infisical CLI installed and are you logged in? (`infisical login`)"}`
      );
    }, this.retry);
  }
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
