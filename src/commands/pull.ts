import { join } from "node:path";
import { compile } from "../core/compile.js";
import { configProviderIds } from "../core/config.js";
import { serializeDotenv } from "../core/dotenv.js";
import { materialize } from "../core/materialize.js";
import type { CompiledManifest } from "../core/types.js";
import {
  discoverManifests,
  type LoadedConfig,
  loadManifest,
  type ManifestFile,
  selectManifests,
  writeSecretFile,
} from "../adapters/workspace.js";
import { type ResolveContext, resolveProviders } from "../providers/registry.js";

export type ResolveOptions = {
  loaded: LoadedConfig;
  environment?: string;
  output?: string;
  /** Manifest profile — loads `.env.<profile>.source` where present. */
  profile?: string;
  /** Restrict to these manifest ids (empty = all discovered). */
  ids?: string[];
  ctx: ResolveContext;
};

/** A manifest resolved to its final `{ VAR: value }` map for an environment. */
export type ResolvedManifest = {
  file: ManifestFile;
  compiled: CompiledManifest;
  vars: Record<string, string>;
};

/**
 * Discover, compile, and materialize every selected manifest for one environment.
 * Providers are authenticated once for the whole run (the union of providers all
 * manifests reference) and reused across manifests.
 */
export async function resolveManifests(
  options: ResolveOptions
): Promise<ResolvedManifest[]> {
  const { loaded, ctx } = options;
  const knownProviders = configProviderIds(loaded.config);
  const files = selectManifests(
    discoverManifests(loaded.root),
    options.ids ?? []
  );

  const compiled = files.map((file) => ({
    file,
    manifest: compile(loadManifest(file, options.profile, knownProviders), loaded.config, {
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.output ? { output: options.output } : {}),
    }),
  }));

  const providerIds = new Set<string>();
  for (const { manifest } of compiled) {
    for (const binding of manifest.bindings) {
      for (const source of binding.sources) providerIds.add(source.provider);
    }
  }
  const providers = await resolveProviders(providerIds, loaded.config, ctx);

  const resolved: ResolvedManifest[] = [];
  for (const { file, manifest } of compiled) {
    resolved.push({
      file,
      compiled: manifest,
      vars: await materialize(manifest, providers),
    });
  }
  return resolved;
}

export type PullOutcome = { id: string; output: string; count: number };

/** Resolve manifests and write each result to its `.env` output file. */
export async function pullToFiles(
  options: ResolveOptions
): Promise<PullOutcome[]> {
  const resolved = await resolveManifests(options);
  return resolved.map(({ file, compiled, vars }) => {
    const outPath = join(file.dir, compiled.output);
    writeSecretFile(outPath, serializeDotenv(vars));
    return {
      id: file.id,
      output: compiled.output,
      count: Object.keys(vars).length,
    };
  });
}
