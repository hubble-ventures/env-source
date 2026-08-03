import type { Provider } from "../core/types.js";
import { type RetryOptions, withRetry } from "./retry.js";

// 1Password reads go through the official SDK (`@1password/sdk`) rather than the
// `op` CLI: it is a plain npm dependency, so there is no binary to find on PATH,
// no subprocess stdout to size-cap and JSON-parse, and one adapter covers both
// auth lanes. It is an *optional* peer dependency, imported on first read — a
// workspace that never references the `onepassword` provider never installs it.
//
// Reads are per *item*, memoised per (environment, path), for the same reason
// the Infisical CLI lane reads per folder: 1Password bills rate limits per API
// request, and the per-account daily ceiling is low enough to matter — 1,000
// reads/24h on Individual/Families/Teams-tier plans, 50,000 on Business. Asking
// per declared key would multiply a pull by the number of keys and reproduce the
// 429 that per-key Infisical reads once caused. `items.get` returns the whole
// item either way, so per-key would buy no privacy for the extra requests.
// Only declared keys are ever returned; the item's other fields are dropped here
// and never reach a manifest or an output file.

/** Module specifier, typed as `string` so it stays a runtime import: neither
 * `tsc` nor the action bundler tries to resolve an optional dependency. */
const SDK_MODULE: string = "@1password/sdk";
const INTEGRATION_NAME = "env-source";
// The SDK requires a `vMAJOR.MINOR.PATCH` string; it identifies the integration
// in 1Password's audit log and is not the env-source package version.
const INTEGRATION_VERSION = "v1.0.0";

// 1Password ids are 26-character lowercase alphanumeric. A path segment shaped
// like one is used as-is, skipping the name → id lookup (and its request).
const OP_ID = /^[a-z0-9]{26}$/;

// Distinguish "this vault/item isn't there" (fine — omit it, exactly as an
// absent Infisical folder is) from a real failure such as an expired session or
// a network error, which must surface rather than read as absent.
const NOT_FOUND = /not found|no item|doesn't exist|does not exist|isn't a vault/i;

// ---------------------------------------------------------------------------
// The slice of the SDK this adapter uses
// ---------------------------------------------------------------------------

// Declared structurally rather than imported: the adapter type-checks and the
// tests run without the optional dependency present, and a fake client is a
// plain object literal.

export type OnePasswordItemField = {
  id: string;
  /** Field name as shown in 1Password — the source key a manifest declares. */
  title: string;
  value?: string;
  sectionId?: string;
  fieldType?: string;
};

export type OnePasswordItem = {
  id: string;
  title: string;
  fields?: OnePasswordItemField[];
  sections?: { id: string; title: string }[];
};

/** `id` + `title` overview, as returned by the list endpoints. */
export type OnePasswordOverview = { id: string; title: string };

/** The `@1password/sdk` client surface this adapter depends on. */
export type OnePasswordClient = {
  vaults: {
    list(): Promise<Iterable<OnePasswordOverview>> | AsyncIterable<OnePasswordOverview>;
  };
  items: {
    list(
      vaultId: string
    ): Promise<Iterable<OnePasswordOverview>> | AsyncIterable<OnePasswordOverview>;
    get(vaultId: string, itemId: string): Promise<OnePasswordItem>;
  };
};

/** Builds an authenticated client. Injectable, for tests. */
export type OnePasswordClientFactory = () => Promise<OnePasswordClient>;

/**
 * How to authenticate. The two lanes mirror Infisical's:
 *  - **local** — the 1Password desktop app, using the developer's own unlocked
 *    session (biometric/password approval). env-source never handles a token.
 *  - **CI** — a service account token from `OP_SERVICE_ACCOUNT_TOKEN`.
 *
 * Unlike Infisical there is no GitHub OIDC lane yet: 1Password's workload
 * identity auth is in public preview and not wired up here, so the CI lane does
 * hold a long-lived credential. See the README.
 */
export type OnePasswordAuth =
  | { kind: "service-account"; token: string }
  | { kind: "desktop"; account: string };

export type OnePasswordOptions = {
  /** Auth lane. Ignored when {@link client} is supplied. */
  auth?: OnePasswordAuth;
  /** Vault used when a manifest path names only an item. */
  vault?: string;
  /** Per-environment vault override, keyed by environment name. */
  vaults?: Record<string, string>;
  /** Injectable client factory, for tests. */
  client?: OnePasswordClientFactory;
  /** Retry policy for transient read failures. */
  retry?: RetryOptions;
};

/**
 * {@link Provider} backed by 1Password.
 *
 * A manifest path addresses an item, optionally qualified by vault and section,
 * and `{env}` is replaced with the environment being resolved:
 *
 * ```
 * #     /Engineering/stripe-{env}        → vault, item
 * #     /Engineering/stripe/webhooks     → vault, item, section
 * #     /stripe                          → item in the configured vault
 * ```
 *
 * The declared keys are field names within that item. The client is built lazily
 * on the first read, so a command that only parses manifests (`list`, `diff`)
 * never triggers a biometric prompt.
 */
export class OnePasswordProvider implements Provider {
  readonly id = "onepassword";
  private readonly options: OnePasswordOptions;
  private readonly retry: RetryOptions;
  private readonly makeClient: OnePasswordClientFactory;
  /** The authenticated client, built once on first use. */
  private clientPromise?: Promise<OnePasswordClient>;
  /**
   * In-flight and completed item reads, keyed by environment + path. `validate`
   * peeks and pulls the same item, and manifests routinely share one; caching
   * the promise (not just the result) also collapses concurrent callers into a
   * single request.
   */
  private readonly items = new Map<string, Promise<Record<string, string>>>();
  /** Vault name → id, resolved once per provider (cleared to retry a failure). */
  private vaultIds: Promise<Map<string, string>> | undefined;
  /** Item name → id, resolved once per vault id. */
  private readonly itemIds = new Map<string, Promise<Map<string, string>>>();

  constructor(options: OnePasswordOptions = {}) {
    this.options = options;
    this.retry = options.retry ?? {};
    this.makeClient =
      options.client ?? (() => createSdkClient(requireAuth(options.auth)));
  }

  async read(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Record<string, string>> {
    const item = await this.readItem(environment, path);
    const out: Record<string, string> = {};
    for (const key of keys) {
      if (Object.hasOwn(item, key)) out[key] = item[key] as string;
    }
    return out;
  }

  async peek(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Set<string>> {
    const item = await this.readItem(environment, path);
    return new Set(keys.filter((key) => Object.hasOwn(item, key)));
  }

  private client(): Promise<OnePasswordClient> {
    this.clientPromise ??= this.makeClient();
    return this.clientPromise;
  }

  /** Every readable field in one item, read once per (environment, path). */
  private readItem(
    environment: string,
    path: string
  ): Promise<Record<string, string>> {
    const cacheKey = `${environment}\0${path}`;
    const cached = this.items.get(cacheKey);
    if (cached) return cached;
    // Drop a failed read from the cache so a later call retries rather than
    // replaying the failure — a CLI run aborts on it either way, but a
    // long-lived library consumer holding one provider should recover.
    const pending = this.fetchItem(environment, path).catch((error) => {
      this.items.delete(cacheKey);
      throw error;
    });
    this.items.set(cacheKey, pending);
    return pending;
  }

  private async fetchItem(
    environment: string,
    path: string
  ): Promise<Record<string, string>> {
    const location = this.parsePath(environment, path);

    const vaultId = await this.resolveVaultId(location.vault);
    if (vaultId === undefined) return {}; // absent vault → absent keys
    const itemId = await this.resolveItemId(vaultId, location.item);
    if (itemId === undefined) return {}; // absent item → absent keys

    const client = await this.client();
    const item = await withRetry(async () => {
      try {
        return await client.items.get(vaultId, itemId);
      } catch (error) {
        if (NOT_FOUND.test(message(error))) return undefined;
        throw new Error(
          `1Password read failed for ${path} (${environment}): ${message(error)}`
        );
      }
    }, this.retry);
    if (!item) return {};

    return selectFields(item, location.section);
  }

  /**
   * Split a manifest path into vault / item / section, substituting `{env}`.
   * One segment names an item in the configured vault; two name vault + item;
   * three add a section.
   */
  private parsePath(
    environment: string,
    path: string
  ): { vault: string; item: string; section?: string } {
    const segments = path
      .replace(/\{env\}/g, environment)
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s !== "");

    if (segments.length === 0 || segments.length > 3) {
      throw new Error(
        `1Password path '${path}' is not '/vault/item', '/vault/item/section', or '/item' (with a configured vault)`
      );
    }

    if (segments.length === 1) {
      const vault = this.configuredVault(environment);
      if (!vault) {
        throw new Error(
          `1Password path '${path}' names only an item, but no vault is configured for environment '${environment}' — set 'vault' (or a 'vaults' entry) under [providers.onepassword], or write '/vault/item'`
        );
      }
      return { vault, item: segments[0] as string };
    }

    const [vault, item, section] = segments as [string, string, string?];
    return { vault, item, ...(section ? { section } : {}) };
  }

  /** Per-environment vault override, else the single configured default. */
  private configuredVault(environment: string): string | undefined {
    return this.options.vaults?.[environment] ?? this.options.vault;
  }

  private async resolveVaultId(name: string): Promise<string | undefined> {
    if (OP_ID.test(name)) return name;
    this.vaultIds ??= this.loadVaultIds();
    try {
      return (await this.vaultIds).get(name);
    } catch (error) {
      this.vaultIds = undefined; // let a later call retry
      throw error;
    }
  }

  private async loadVaultIds(): Promise<Map<string, string>> {
    const client = await this.client();
    return withRetry(async () => {
      const vaults = await collect(client.vaults.list());
      return byTitle(vaults);
    }, this.retry);
  }

  private async resolveItemId(
    vaultId: string,
    name: string
  ): Promise<string | undefined> {
    if (OP_ID.test(name)) return name;
    let pending = this.itemIds.get(vaultId);
    if (!pending) {
      pending = this.loadItemIds(vaultId).catch((error) => {
        this.itemIds.delete(vaultId);
        throw error;
      });
      this.itemIds.set(vaultId, pending);
    }
    return (await pending).get(name);
  }

  private async loadItemIds(vaultId: string): Promise<Map<string, string>> {
    const client = await this.client();
    return withRetry(async () => {
      // Overviews only — `items.list` returns id/title/category and never field
      // values, so nothing secret crosses the wire for a name lookup.
      const overviews = await collect(client.items.list(vaultId));
      return byTitle(overviews);
    }, this.retry);
  }
}

/**
 * The item's fields as `{ name: value }`.
 *
 * With a section segment, only that section's fields are considered — the
 * `op://vault/item/section/field` addressing. Without one, every field in the
 * item is eligible and the first occurrence of a name wins; add the section
 * segment when two sections use the same field name.
 */
function selectFields(
  item: OnePasswordItem,
  section?: string
): Record<string, string> {
  let sectionId: string | undefined;
  if (section !== undefined) {
    sectionId = (item.sections ?? []).find((s) => s.title === section)?.id;
    if (sectionId === undefined) return {}; // absent section → absent keys
  }

  const out: Record<string, string> = {};
  for (const field of item.fields ?? []) {
    if (sectionId !== undefined && field.sectionId !== sectionId) continue;
    // Fields with no readable string value (files, OTP-only entries) are absent
    // rather than empty — a provider never fakes a value.
    if (typeof field.value !== "string") continue;
    if (!Object.hasOwn(out, field.title)) out[field.title] = field.value;
  }
  return out;
}

function requireAuth(auth: OnePasswordAuth | undefined): OnePasswordAuth {
  if (auth) return auth;
  throw new Error(
    "No 1Password credentials. Set OP_SERVICE_ACCOUNT_TOKEN (CI), or set 'account' under [providers.onepassword] (or $OP_ACCOUNT) to use the desktop app locally."
  );
}

/** Build an authenticated SDK client, loading the optional dependency lazily. */
async function createSdkClient(
  auth: OnePasswordAuth
): Promise<OnePasswordClient> {
  let sdk: {
    createClient(config: unknown): Promise<OnePasswordClient>;
    DesktopAuth: new (account: string) => unknown;
  };
  try {
    sdk = (await import(SDK_MODULE)) as typeof sdk;
  } catch {
    throw new Error(
      "The 'onepassword' provider needs the 1Password SDK, which is an optional peer dependency. Install it with `npm install @1password/sdk`."
    );
  }

  const credential =
    auth.kind === "service-account"
      ? auth.token
      : new sdk.DesktopAuth(auth.account);

  return sdk.createClient({
    auth: credential,
    integrationName: INTEGRATION_NAME,
    integrationVersion: INTEGRATION_VERSION,
  });
}

/** Drain a list result, which the SDK returns as an array or an async iterable. */
async function collect<T>(
  source: Promise<Iterable<T>> | AsyncIterable<T>
): Promise<T[]> {
  const resolved: unknown = await source;
  const out: T[] = [];
  if (
    resolved != null &&
    typeof (resolved as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  ) {
    for await (const value of resolved as AsyncIterable<T>) out.push(value);
    return out;
  }
  for (const value of (resolved as Iterable<T> | undefined) ?? []) {
    out.push(value);
  }
  return out;
}

/** Title → id. First occurrence wins, matching 1Password's own name lookup. */
function byTitle(overviews: OnePasswordOverview[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { id, title } of overviews) {
    if (!map.has(title)) map.set(title, id);
  }
  return map;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
