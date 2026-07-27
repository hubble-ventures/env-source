import { describe, expect, it } from "vitest";
import { compile } from "../src/core/compile.js";
import type { EnvSourceConfig } from "../src/core/config.js";
import { parseEnvSource } from "../src/core/parse.js";
import type { Provider } from "../src/core/types.js";
import { hasErrors, validate } from "../src/core/validate.js";
import { FakeProvider } from "./helpers.js";

const config: EnvSourceConfig = { providers: { infisical: { project: "acme" } } };

function compiled(text: string, environment = "development") {
  return compile(parseEnvSource(text), config, { environment });
}

describe("validate", () => {
  it("flags an active binding with no container path", async () => {
    // A provider decorator with no `/path` line.
    const manifest = compiled(["# infisical", "A="].join("\n"));
    const issues = await validate(manifest);
    expect(issues.some((i) => i.code === "missing_path")).toBe(true);
    expect(hasErrors(issues)).toBe(true);
  });

  it("passes structural validation for a well-formed manifest", async () => {
    const manifest = compiled(["# infisical", "#     /shared", "A="].join("\n"));
    expect(await validate(manifest)).toEqual([]);
  });

  it("peeks the provider and errors on a missing required key", async () => {
    const vault = new FakeProvider("infisical", {
      development: { "/shared": { PRESENT: "x" } },
    });
    const manifest = compiled(
      ["# infisical", "#     /shared", "PRESENT=", "# infisical", "#     /shared", "ABSENT="].join(
        "\n"
      )
    );
    const issues = await validate(manifest, providers(vault));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unresolved", key: "ABSENT" });
    expect(vault.peeks).toBeGreaterThan(0);
  });

  it("is satisfied when any source in a chain has the key", async () => {
    const vault = new FakeProvider("infisical", {
      development: { "/fallback": { TOKEN: "y" } },
    });
    // Primary source absent, second source present → no issue.
    const manifest = compiled(
      [
        "# infisical",
        "#     /primary",
        "# infisical",
        "#     /fallback",
        "TOKEN=",
      ].join("\n")
    );
    expect(await validate(manifest, providers(vault))).toEqual([]);
  });

  it("downgrades a missing key with a default to a warning", async () => {
    const vault = new FakeProvider("infisical", { development: { "/shared": {} } });
    const manifest = compiled(
      ["# infisical", "#     /shared", "ABSENT=fallback"].join("\n")
    );
    const issues = await validate(manifest, providers(vault));
    expect(issues[0]?.level).toBe("warning");
    expect(hasErrors(issues)).toBe(false);
  });

  it("flags a present-but-empty value with --check-values", async () => {
    const vault = new FakeProvider("infisical", {
      development: { "/shared": { EMPTY: "" } },
    });
    const manifest = compiled(["# infisical", "#     /shared", "EMPTY="].join("\n"));
    const lenient = await validate(manifest, providers(vault));
    expect(lenient).toEqual([]); // peek sees it present
    const strict = await validate(manifest, providers(vault), {
      checkValues: true,
    });
    expect(strict[0]).toMatchObject({ code: "unresolved", key: "EMPTY" });
  });
});

function providers(p: Provider): Map<string, Provider> {
  return new Map([[p.id, p]]);
}
