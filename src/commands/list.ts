import { compile } from "../core/compile.js";
import { configProviderIds } from "../core/config.js";
import {
  discoverManifests,
  type LoadedConfig,
  loadManifest,
} from "../adapters/workspace.js";

export type ManifestSummary = {
  id: string;
  path: string;
  /** Total variables declared in the manifest. */
  vars: number;
  /** Distinct providers the manifest sources from (excluding literals). */
  providers: string[];
};

/** Summarize every discovered manifest without touching any provider. */
export function listManifests(
  loaded: LoadedConfig,
  environment?: string,
  profile?: string
): ManifestSummary[] {
  const knownProviders = configProviderIds(loaded.config);
  return discoverManifests(loaded.root).map((file) => {
    const manifest = compile(loadManifest(file, profile, knownProviders), loaded.config, {
      ...(environment ? { environment } : {}),
    });
    const providers = [
      ...new Set(
        manifest.bindings.flatMap((b) => b.sources.map((s) => s.provider))
      ),
    ].sort();
    return {
      id: file.id,
      path: file.path,
      vars: manifest.bindings.length,
      providers,
    };
  });
}
