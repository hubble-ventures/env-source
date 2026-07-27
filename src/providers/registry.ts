import type { EnvSourceConfig } from "../core/config.js";
import type { Provider } from "../core/types.js";
import {
  InfisicalApiProvider,
  InfisicalCliProvider,
  infisicalCliAvailable,
} from "./infisical.js";

/** Ambient inputs a provider needs to authenticate — credentials, OIDC. */
export type ResolveContext = {
  /** Environment variables (project id, OIDC identity, …). */
  env: Record<string, string | undefined>;
  /**
   * Mint a GitHub OIDC JWT for the given audience. Supplied by the GHA lane;
   * absent locally, which selects the Infisical CLI lane instead.
   */
  getOidcJwt?: (audience: string) => Promise<string>;
};

/**
 * Build the concrete {@link Provider}s referenced by a set of provider ids. Only
 * referenced providers are constructed, so a manifest that never uses Infisical
 * never triggers an Infisical login.
 *
 * Infisical has exactly two lanes and no others:
 *  - **CI** — GitHub OIDC (identity id + the OIDC minter) exchanged for a
 *    short-lived REST token.
 *  - **local** — the Infisical CLI, using the developer's own `infisical login`
 *    session. env-source never sees a token.
 */
export async function resolveProviders(
  providerIds: Iterable<string>,
  config: EnvSourceConfig,
  ctx: ResolveContext
): Promise<Map<string, Provider>> {
  const map = new Map<string, Provider>();
  for (const id of new Set(providerIds)) {
    map.set(id, await buildProvider(id, config, ctx));
  }
  return map;
}

async function buildProvider(
  id: string,
  config: EnvSourceConfig,
  ctx: ResolveContext
): Promise<Provider> {
  switch (id) {
    case "infisical":
      return buildInfisical(config, ctx);
    default:
      throw new Error(
        `Unknown provider '${id}' — no adapter is registered for it`
      );
  }
}

async function buildInfisical(
  config: EnvSourceConfig,
  ctx: ResolveContext
): Promise<Provider> {
  const cfg = config.providers?.infisical;
  if (!cfg) {
    throw new Error(
      "Manifest references the 'infisical' provider but env-source.toml has no [providers.infisical] block"
    );
  }
  const { env } = ctx;

  // CI lane: GitHub OIDC → short-lived REST token.
  const identityId = env.INFISICAL_IDENTITY_ID;
  if (identityId && ctx.getOidcJwt) {
    const audience = env.INFISICAL_OIDC_AUDIENCE ?? cfg.oidc_audience ?? "";
    const jwt = await ctx.getOidcJwt(audience);
    const baseUrl = env.INFISICAL_API_URL ?? cfg.api_url;
    return InfisicalApiProvider.loginWithOidc({
      identityId,
      jwt,
      project: cfg.project,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }

  // Local lane: the Infisical CLI using the developer's own session.
  if (!infisicalCliAvailable()) {
    throw new Error(
      "The Infisical CLI is not installed or not on PATH. Install it and run `infisical login` (local), or provide GitHub OIDC (INFISICAL_IDENTITY_ID) in CI."
    );
  }
  const projectId = cfg.project_id ?? env.INFISICAL_PROJECT_ID ?? cfg.project;
  return new InfisicalCliProvider({ projectId });
}
