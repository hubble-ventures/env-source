import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { LoadedConfig } from "../adapters/workspace.js";
import type { ResolveContext } from "../providers/registry.js";
import { resolveManifests } from "./pull.js";

export type RunOptions = {
  loaded: LoadedConfig;
  environment?: string;
  /** Manifest profile — loads `.env.<profile>.source` where present. */
  profile?: string;
  /** Restrict resolution to these manifest ids (empty = all discovered). */
  ids?: string[];
  ctx: ResolveContext;
  /** Command to exec, then its args. */
  command: string;
  args: string[];
};

/**
 * Resolve every selected manifest and exec a command with the resolved variables
 * injected into its environment — the secrets never touch disk. Returns the
 * child's exit code (128 + signal when it was killed by a signal).
 *
 * Later manifests win on a key collision across manifests, matching how a merged
 * environment would resolve; within the current process env, resolved values take
 * precedence so the command sees the vault's values.
 */
export async function runWithEnv(options: RunOptions): Promise<number> {
  const resolved = await resolveManifests({
    loaded: options.loaded,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ids: options.ids ?? [],
    ctx: options.ctx,
  });

  const merged: Record<string, string> = {};
  for (const { vars } of resolved) Object.assign(merged, vars);

  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(options.command, options.args, {
      stdio: "inherit",
      env: { ...process.env, ...merged },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        const num = (constants.signals as Record<string, number>)[signal] ?? 1;
        resolvePromise(128 + num);
      } else {
        resolvePromise(code ?? 0);
      }
    });
  });
}
