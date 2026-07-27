import { z } from "zod";

// The root `env-source.toml` holds provider-specific context (Infisical project
// slug, API URL, …) plus workspace defaults. It is *non-secret* and committed;
// credentials come from the environment at resolve time, never from here.

const outputName = z
  .string()
  .regex(/^[^/\\]+$/, "output must be a bare filename (no path separators)");

/** Provider block for Infisical. */
const infisicalConfigSchema = z
  .object({
    /** Infisical project slug — used by the REST/OIDC lane in CI. */
    project: z.string().min(1),
    /**
     * Infisical project id (UUID) — used by the local Infisical CLI lane. Falls
     * back to the env var `INFISICAL_PROJECT_ID`, then to `project`.
     */
    project_id: z.string().min(1).optional(),
    /** API base URL. Defaults to the Infisical cloud at resolve time. */
    api_url: z.string().url().optional(),
    /** OIDC audience the CI machine identity expects. */
    oidc_audience: z.string().optional(),
  })
  .strict();

export type InfisicalConfig = z.infer<typeof infisicalConfigSchema>;

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    /** Environment used when a command doesn't name one. Default `development`. */
    default_environment: z.string().min(1).optional(),
    /** Output filename written next to each `.env.source`. Default `.env`. */
    output: outputName.optional(),
    providers: z
      .object({
        infisical: infisicalConfigSchema.optional(),
      })
      // Allow unknown provider blocks so a manifest can reference a provider this
      // version doesn't yet type without failing the whole config load.
      .passthrough()
      .optional(),
  })
  .strict();

export type EnvSourceConfig = z.infer<typeof configSchema>;

export const DEFAULT_ENVIRONMENT = "development";
export const DEFAULT_OUTPUT = ".env";

/** Validate an already-parsed TOML object against the config schema. Throws on error. */
export function parseConfig(raw: unknown): EnvSourceConfig {
  return configSchema.parse(raw);
}

/** The effective default environment for a config. */
export function configEnvironment(config: EnvSourceConfig): string {
  return config.default_environment ?? DEFAULT_ENVIRONMENT;
}

/** The effective output filename for a config. */
export function configOutput(config: EnvSourceConfig): string {
  return config.output ?? DEFAULT_OUTPUT;
}

/** The provider ids declared under `[providers.*]` — passed to the parser to
 * disambiguate a bare token (known provider vs. source-key alias). */
export function configProviderIds(config: EnvSourceConfig): string[] {
  return Object.keys(config.providers ?? {});
}
