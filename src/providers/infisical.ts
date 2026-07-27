import { spawnSync } from "node:child_process";
import { parseDotenv } from "../core/dotenv.js";
import type { Provider } from "../core/types.js";
import { type RetryOptions, withRetry } from "./retry.js";

const DEFAULT_API_URL = "https://app.infisical.com";
// Bound every request so a hung vault can't stall a CI job up to undici's 300s
// default; the caller (or the job timeout) handles a genuine outage.
const REQUEST_TIMEOUT_MS = 30_000;

type RawSecret = { secretKey: string; secretValue: string };
type RawFolder = { secrets: RawSecret[]; imports?: { secrets?: RawSecret[] }[] };

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
 * is stored. Reads expand secret references and include folder imports so the
 * result matches what the Infisical UI shows.
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
    const wanted = new Set(keys);
    const folder = await this.readFolder(environment, path);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(folder)) {
      if (wanted.has(key)) out[key] = value;
    }
    return out;
  }

  /**
   * Assert which keys exist without surfacing values. Infisical's raw API returns
   * values, so we read then discard them here — the value never leaves this method.
   */
  async peek(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Set<string>> {
    const present = new Set(Object.keys(await this.readFolder(environment, path)));
    return new Set(keys.filter((k) => present.has(k)));
  }

  private async readFolder(
    environment: string,
    path: string
  ): Promise<Record<string, string>> {
    const url = new URL(`${this.baseUrl}/api/v3/secrets/raw`);
    url.searchParams.set("workspaceSlug", this.project);
    url.searchParams.set("environment", environment);
    url.searchParams.set("secretPath", path);
    // Match the values the UI resolves: pull in imported folders and expand
    // `${REF}` secret references rather than returning them literally.
    url.searchParams.set("include_imports", "true");
    url.searchParams.set("expandSecretReferences", "true");

    const res = await withRetry(
      () =>
        fetchOk(url, {
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      this.retry
    );
    const data = (await res.json()) as RawFolder;
    const out: Record<string, string> = {};
    // Imports first so a same-named key in this folder wins (Infisical's precedence).
    for (const imp of data.imports ?? []) {
      for (const s of imp.secrets ?? []) out[s.secretKey] = s.secretValue;
    }
    for (const s of data.secrets) out[s.secretKey] = s.secretValue;
    return out;
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
 * token. The CLI already expands references and includes imports.
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
    const wanted = new Set(keys);
    const folder = await this.exportFolder(environment, path);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(folder)) {
      if (wanted.has(key)) out[key] = value;
    }
    return out;
  }

  async peek(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Set<string>> {
    const present = new Set(Object.keys(await this.exportFolder(environment, path)));
    return new Set(keys.filter((k) => present.has(k)));
  }

  private exportFolder(
    environment: string,
    path: string
  ): Promise<Record<string, string>> {
    return withRetry(() => {
      const result = this.spawn("infisical", [
        "export",
        `--projectId=${this.projectId}`,
        `--env=${environment}`,
        `--path=${path}`,
        "--format=dotenv",
        "--silent",
      ]);
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new Error(
          `infisical export failed for ${path} (${environment}): ${detail || "is the Infisical CLI installed and are you logged in? (`infisical login`)"}`
        );
      }
      return parseDotenv(result.stdout);
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
