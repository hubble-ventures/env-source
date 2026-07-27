import { describe, expect, it } from "vitest";
import { compile } from "../src/core/compile.js";
import type { EnvSourceConfig } from "../src/core/config.js";
import {
  diffCompiled,
  isEmptyDelta,
  renderDeltaMarkdown,
  renderDeltaText,
} from "../src/core/diff.js";
import { parseEnvSource } from "../src/core/parse.js";
import type { CompiledManifest } from "../src/core/types.js";

const config: EnvSourceConfig = { providers: { infisical: { project: "acme" } } };

function compiled(text: string, environment = "development"): CompiledManifest {
  return compile(parseEnvSource(text), config, { environment });
}

describe("diffCompiled", () => {
  it("reports an unchanged manifest as an empty delta", () => {
    const m = compiled(["# infisical", "#     /shared", "A="].join("\n"));
    expect(isEmptyDelta(diffCompiled(m, m))).toBe(true);
  });

  it("detects an added variable", () => {
    const base = compiled(["# infisical", "#     /shared", "A="].join("\n"));
    const head = compiled(
      ["# infisical", "#     /shared", "A=", "# infisical", "#     /shared", "B="].join(
        "\n"
      )
    );
    const delta = diffCompiled(base, head);
    expect(delta.added.map((b) => b.targetVar)).toEqual(["B"]);
    expect(delta.removed).toEqual([]);
  });

  it("detects a removed variable", () => {
    const base = compiled(
      ["# infisical", "#     /shared", "A=", "# infisical", "#     /shared", "B="].join(
        "\n"
      )
    );
    const head = compiled(["# infisical", "#     /shared", "A="].join("\n"));
    const delta = diffCompiled(base, head);
    expect(delta.removed.map((b) => b.targetVar)).toEqual(["B"]);
  });

  it("detects a changed source path", () => {
    const base = compiled(["# infisical", "#     /shared", "A="].join("\n"));
    const head = compiled(["# infisical", "#     /other", "A="].join("\n"));
    const delta = diffCompiled(base, head);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0]).toMatchObject({ targetVar: "A" });
    expect(delta.changed[0]?.from.sources[0]?.path).toBe("/shared");
    expect(delta.changed[0]?.to.sources[0]?.path).toBe("/other");
  });

  it("treats an environment-scope narrowing as a change", () => {
    // In production the binding flips from active (all envs) to inactive.
    const base = compiled(["# infisical", "#     /shared", "A="].join("\n"), "production");
    const head = compiled(
      ["# infisical", "# (development)", "#     /shared", "A=x"].join("\n"),
      "production"
    );
    const delta = diffCompiled(base, head);
    expect(delta.changed).toHaveLength(1);
  });

  it("renders text and markdown for a delta", () => {
    const base = compiled(["# infisical", "#     /shared", "A="].join("\n"));
    const head = compiled(["# infisical", "#     /other", "A="].join("\n"));
    const delta = diffCompiled(base, head);
    expect(renderDeltaText(delta)).toContain("~ A");
    const md = renderDeltaMarkdown(delta, "apps/api");
    expect(md).toContain("### apps/api");
    expect(md).toContain("`~ changed`");
    expect(md).toContain("0 added · 0 removed · 1 changed");
  });
});
