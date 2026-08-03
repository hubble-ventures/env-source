import { describe, expect, it, vi } from "vitest";
import {
  OnePasswordProvider,
  type OnePasswordClient,
  type OnePasswordItem,
} from "../src/providers/onepassword.js";
import { resolveProviders } from "../src/providers/registry.js";
import { parseConfig } from "../src/core/config.js";

type Vault = { id: string; title: string; items: OnePasswordItem[] };

/**
 * A fake SDK client over an in-memory account, with call counters so tests can
 * assert how many requests a read actually costs — the whole point of reading
 * per item rather than per key.
 */
function fakeAccount(vaults: Vault[]) {
  const calls = { vaultList: 0, itemList: 0, itemGet: 0 };
  const client: OnePasswordClient = {
    vaults: {
      list: async () => {
        calls.vaultList++;
        return vaults.map(({ id, title }) => ({ id, title }));
      },
    },
    items: {
      list: async (vaultId) => {
        calls.itemList++;
        const vault = vaults.find((v) => v.id === vaultId);
        return (vault?.items ?? []).map(({ id, title }) => ({ id, title }));
      },
      get: async (vaultId, itemId) => {
        calls.itemGet++;
        const item = vaults
          .find((v) => v.id === vaultId)
          ?.items.find((i) => i.id === itemId);
        if (!item) throw new Error("item not found");
        return item;
      },
    },
  };
  return { client, calls };
}

function item(
  title: string,
  fields: Record<string, string>,
  extra: Partial<OnePasswordItem> = {}
): OnePasswordItem {
  return {
    id: `item-${title}`,
    title,
    fields: Object.entries(fields).map(([name, value]) => ({
      id: `f-${name}`,
      title: name,
      value,
    })),
    ...extra,
  };
}

const ENGINEERING: Vault = {
  id: "vault-eng",
  title: "Engineering",
  items: [
    item("stripe", { API_KEY: "sk_live", WEBHOOK: "whsec", NOISE: "ignored" }),
    item("stripe-production", { API_KEY: "sk_prod" }),
  ],
};

function provider(vaults: Vault[], options = {}) {
  const { client, calls } = fakeAccount(vaults);
  return {
    calls,
    provider: new OnePasswordProvider({
      client: () => Promise.resolve(client),
      ...options,
    }),
  };
}

describe("OnePasswordProvider", () => {
  it("returns only the declared keys and omits absent ones", async () => {
    const { provider: op } = provider([ENGINEERING]);
    const values = await op.read("development", "/Engineering/stripe", [
      "API_KEY",
      "ABSENT",
    ]);
    // NOISE is in the item but undeclared — it never reaches the caller.
    expect(values).toEqual({ API_KEY: "sk_live" });
  });

  it("reads the item once per (environment, path), not once per key", async () => {
    const { provider: op, calls } = provider([ENGINEERING]);
    await op.read("development", "/Engineering/stripe", ["API_KEY", "WEBHOOK"]);
    // validate peeks the same item a pull then reads — still one request.
    await op.peek("development", "/Engineering/stripe", ["API_KEY"]);
    expect(calls.itemGet).toBe(1);
    // Name → id lookups are resolved once each, not per read.
    expect(calls.vaultList).toBe(1);
    expect(calls.itemList).toBe(1);
  });

  it("collapses concurrent reads of one item into a single request", async () => {
    const { provider: op, calls } = provider([ENGINEERING]);
    await Promise.all([
      op.read("development", "/Engineering/stripe", ["API_KEY"]),
      op.read("development", "/Engineering/stripe", ["WEBHOOK"]),
      op.peek("development", "/Engineering/stripe", ["API_KEY"]),
    ]);
    expect(calls.itemGet).toBe(1);
  });

  it("substitutes {env} in the path", async () => {
    const { provider: op } = provider([ENGINEERING]);
    expect(
      await op.read("production", "/Engineering/stripe-{env}", ["API_KEY"])
    ).toEqual({ API_KEY: "sk_prod" });
    expect(
      await op.read("development", "/Engineering/stripe", ["API_KEY"])
    ).toEqual({ API_KEY: "sk_live" });
  });

  it("uses the configured vault when the path names only an item", async () => {
    const { provider: op } = provider([ENGINEERING], { vault: "Engineering" });
    expect(await op.read("development", "/stripe", ["API_KEY"])).toEqual({
      API_KEY: "sk_live",
    });
  });

  it("prefers the per-environment vault over the default", async () => {
    const prod: Vault = {
      id: "vault-prod",
      title: "Production",
      items: [item("stripe", { API_KEY: "sk_from_prod_vault" })],
    };
    const { provider: op } = provider([ENGINEERING, prod], {
      vault: "Engineering",
      vaults: { production: "Production" },
    });
    expect(await op.read("production", "/stripe", ["API_KEY"])).toEqual({
      API_KEY: "sk_from_prod_vault",
    });
    expect(await op.read("development", "/stripe", ["API_KEY"])).toEqual({
      API_KEY: "sk_live",
    });
  });

  it("errors when a bare item path has no vault configured", async () => {
    const { provider: op } = provider([ENGINEERING]);
    await expect(op.read("development", "/stripe", ["API_KEY"])).rejects.toThrow(
      /no vault is configured/
    );
  });

  it("takes 26-character ids verbatim, skipping the lookup requests", async () => {
    const vault: Vault = {
      id: "abcdefghijklmnopqrstuvwxyz",
      title: "Engineering",
      items: [
        { ...item("stripe", { API_KEY: "sk" }), id: "zyxwvutsrqponmlkjihgfedcba" },
      ],
    };
    const { provider: op, calls } = provider([vault]);
    const values = await op.read(
      "development",
      "/abcdefghijklmnopqrstuvwxyz/zyxwvutsrqponmlkjihgfedcba",
      ["API_KEY"]
    );
    expect(values).toEqual({ API_KEY: "sk" });
    expect(calls.vaultList).toBe(0);
    expect(calls.itemList).toBe(0);
  });

  it("scopes fields to a section when the path names one", async () => {
    const sectioned: OnePasswordItem = {
      id: "item-multi",
      title: "multi",
      sections: [
        { id: "s-live", title: "live" },
        { id: "s-test", title: "test" },
      ],
      fields: [
        { id: "1", title: "API_KEY", value: "live_key", sectionId: "s-live" },
        { id: "2", title: "API_KEY", value: "test_key", sectionId: "s-test" },
      ],
    };
    const vault: Vault = { id: "v", title: "Engineering", items: [sectioned] };
    const { provider: op } = provider([vault]);
    expect(
      await op.read("development", "/Engineering/multi/test", ["API_KEY"])
    ).toEqual({ API_KEY: "test_key" });
  });

  it("treats an absent vault, item, or section as absent keys, not an error", async () => {
    const { provider: op } = provider([ENGINEERING]);
    expect(await op.read("development", "/Nope/stripe", ["API_KEY"])).toEqual({});
    expect(await op.read("development", "/Engineering/nope", ["API_KEY"])).toEqual(
      {}
    );
    expect(
      await op.read("development", "/Engineering/stripe/nope", ["API_KEY"])
    ).toEqual({});
  });

  it("surfaces a real read failure instead of reporting keys absent", async () => {
    const client: OnePasswordClient = {
      vaults: { list: async () => [{ id: "v", title: "Engineering" }] },
      items: {
        list: async () => [{ id: "i", title: "stripe" }],
        get: async () => {
          throw new Error("session expired");
        },
      },
    };
    const op = new OnePasswordProvider({
      client: () => Promise.resolve(client),
      retry: { attempts: 1 },
    });
    await expect(
      op.read("development", "/Engineering/stripe", ["API_KEY"])
    ).rejects.toThrow(/session expired/);
  });

  it("omits fields with no readable string value rather than faking one", async () => {
    const vault: Vault = {
      id: "v",
      title: "Engineering",
      items: [
        {
          id: "i",
          title: "stripe",
          fields: [
            { id: "1", title: "API_KEY", value: "sk" },
            { id: "2", title: "ATTACHMENT" },
          ],
        },
      ],
    };
    const { provider: op } = provider([vault]);
    const values = await op.read("development", "/Engineering/stripe", [
      "API_KEY",
      "ATTACHMENT",
    ]);
    expect(values).toEqual({ API_KEY: "sk" });
  });

  it("builds no client until a value is actually needed", async () => {
    const factory = vi.fn();
    new OnePasswordProvider({ client: factory });
    // Constructing the provider must not sign in — `list`/`diff` resolve
    // providers without reading, and a desktop prompt here would be gratuitous.
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("resolveProviders — onepassword", () => {
  const config = parseConfig({
    providers: { onepassword: { vault: "Engineering" } },
  });

  it("requires a [providers.onepassword] block", async () => {
    await expect(
      resolveProviders(["onepassword"], parseConfig({}), { env: {} })
    ).rejects.toThrow(/has no \[providers.onepassword\] block/);
  });

  it("builds a provider from a service account token", async () => {
    const map = await resolveProviders(["onepassword"], config, {
      env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_token" },
    });
    expect(map.get("onepassword")?.id).toBe("onepassword");
  });

  it("fails on first read when no lane is available", async () => {
    const map = await resolveProviders(["onepassword"], config, { env: {} });
    await expect(
      map.get("onepassword")?.read("development", "/stripe", ["A"])
    ).rejects.toThrow(/No 1Password credentials/);
  });
});
