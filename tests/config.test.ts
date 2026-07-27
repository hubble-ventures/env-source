import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  configEnvironment,
  configOutput,
  parseConfig,
} from "../src/core/config.js";

describe("parseConfig", () => {
  it("parses a full infisical config from TOML", () => {
    const config = parseConfig(
      parseToml(
        [
          'default_environment = "preview"',
          'output = ".env.local"',
          "[providers.infisical]",
          'project = "acme-payments"',
          'project_id = "00000000-0000-0000-0000-000000000000"',
        ].join("\n")
      )
    );
    expect(config.providers?.infisical?.project).toBe("acme-payments");
    expect(config.providers?.infisical?.project_id).toBe(
      "00000000-0000-0000-0000-000000000000"
    );
    expect(configEnvironment(config)).toBe("preview");
    expect(configOutput(config)).toBe(".env.local");
  });

  it("applies defaults for environment and output", () => {
    const config = parseConfig({});
    expect(configEnvironment(config)).toBe("development");
    expect(configOutput(config)).toBe(".env");
  });

  it("rejects an output filename with path separators", () => {
    expect(() => parseConfig({ output: "sub/.env" })).toThrow();
  });

  it("rejects an infisical block missing the project slug", () => {
    expect(() =>
      parseConfig({ providers: { infisical: { fetch: "folder" } } })
    ).toThrow();
  });
});
