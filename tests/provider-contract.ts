import { describe, expect, it } from "vitest";
import type { Provider } from "../src/core/types.js";

// The behaviour every Provider must share, regardless of the backend behind it.
// `materialize` and `validate` are written against these guarantees and nothing
// else: a provider that breaks one of them corrupts a `.env` rather than failing
// loudly. Each implementation supplies a fixture over the same dataset below and
// gets the whole suite; the assertions live here once so a new provider inherits
// them instead of re-deriving (and quietly narrowing) them.

/**
 * The dataset every fixture must expose, as `{ environment: { path: keys } }`.
 *
 * `NOISE` sits in the container but is never declared by a caller — it is the
 * probe for leakage. `EMPTY` is present with an empty value, which is *not* the
 * same as absent: `validate --check-values` exists to tell those apart, so a
 * provider that conflates them silently defeats it.
 */
export const CONTRACT_DATA: Record<
  string,
  Record<string, Record<string, string>>
> = {
  development: {
    "/shared": { A: "1", B: "2", EMPTY: "", NOISE: "undeclared" },
  },
  production: {
    "/shared": { A: "prod", NOISE: "undeclared" },
  },
};

/** A container no fixture defines, in any environment. */
export const ABSENT_PATH = "/absent";

/**
 * Assert one {@link Provider} implementation against the shared contract.
 *
 * `makeProvider` returns a provider over {@link CONTRACT_DATA}, freshly built
 * per test so per-instance caches never leak between them.
 */
export function describeProviderContract(
  name: string,
  makeProvider: () => Provider | Promise<Provider>
): void {
  describe(`Provider contract — ${name}`, () => {
    it("returns the requested keys that exist", async () => {
      const provider = await makeProvider();
      expect(await provider.read("development", "/shared", ["A", "B"])).toEqual({
        A: "1",
        B: "2",
      });
    });

    it("omits a key that does not exist rather than faking one", async () => {
      const provider = await makeProvider();
      const values = await provider.read("development", "/shared", [
        "A",
        "MISSING",
      ]);
      expect(values).toEqual({ A: "1" });
      expect(Object.hasOwn(values, "MISSING")).toBe(false);
    });

    it("never returns a key that was not requested", async () => {
      const provider = await makeProvider();
      // NOISE is in the container. Asking for A must not surface it — this is
      // the guarantee that nothing undeclared reaches a `.env`.
      const values = await provider.read("development", "/shared", ["A"]);
      expect(Object.keys(values)).toEqual(["A"]);
    });

    it("distinguishes an empty value from an absent key", async () => {
      const provider = await makeProvider();
      const values = await provider.read("development", "/shared", [
        "EMPTY",
        "MISSING",
      ]);
      expect(values).toEqual({ EMPTY: "" });
      expect(Object.hasOwn(values, "EMPTY")).toBe(true);
      expect(await provider.peek("development", "/shared", ["EMPTY"])).toEqual(
        new Set(["EMPTY"])
      );
    });

    it("scopes reads to the environment", async () => {
      const provider = await makeProvider();
      expect(await provider.read("development", "/shared", ["A"])).toEqual({
        A: "1",
      });
      expect(await provider.read("production", "/shared", ["A"])).toEqual({
        A: "prod",
      });
    });

    it("does not leak a key across environments", async () => {
      const provider = await makeProvider();
      // B exists in development only; production must report it absent.
      expect(await provider.read("production", "/shared", ["A", "B"])).toEqual({
        A: "prod",
      });
      expect(await provider.peek("production", "/shared", ["B"])).toEqual(
        new Set()
      );
    });

    it("treats an absent container as absent keys, not an error", async () => {
      const provider = await makeProvider();
      expect(await provider.read("development", ABSENT_PATH, ["A"])).toEqual({});
      expect(await provider.peek("development", ABSENT_PATH, ["A"])).toEqual(
        new Set()
      );
    });

    it("peeks exactly the requested keys that exist", async () => {
      const provider = await makeProvider();
      const present = await provider.peek("development", "/shared", [
        "A",
        "MISSING",
      ]);
      expect(present).toEqual(new Set(["A"]));
      // NOISE exists but was not asked about — peek reports on the question it
      // was given, never on the container's other contents.
      expect(present.has("NOISE")).toBe(false);
    });

    it("agrees between read and peek on which keys are present", async () => {
      const provider = await makeProvider();
      const keys = ["A", "B", "EMPTY", "MISSING"];
      const values = await provider.read("development", "/shared", keys);
      const present = await provider.peek("development", "/shared", keys);
      expect(new Set(Object.keys(values))).toEqual(present);
    });

    it("handles an empty key list", async () => {
      const provider = await makeProvider();
      expect(await provider.read("development", "/shared", [])).toEqual({});
      expect(await provider.peek("development", "/shared", [])).toEqual(
        new Set()
      );
    });

    it("is stable across repeated reads", async () => {
      const provider = await makeProvider();
      // Providers memoise containers; a second read must return the same values,
      // not a half-populated cache.
      const first = await provider.read("development", "/shared", ["A", "B"]);
      const second = await provider.read("development", "/shared", ["A", "B"]);
      expect(second).toEqual(first);
    });

    it("serves concurrent reads of the same container consistently", async () => {
      const provider = await makeProvider();
      const [a, b, present] = await Promise.all([
        provider.read("development", "/shared", ["A"]),
        provider.read("development", "/shared", ["B"]),
        provider.peek("development", "/shared", ["A", "MISSING"]),
      ]);
      expect(a).toEqual({ A: "1" });
      expect(b).toEqual({ B: "2" });
      expect(present).toEqual(new Set(["A"]));
    });

    it("exposes a non-empty id", async () => {
      const provider = await makeProvider();
      expect(provider.id).toMatch(/^[a-z][a-z0-9-]*$/);
    });
  });
}
