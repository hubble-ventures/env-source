import type { Provider } from "../src/core/types.js";

/**
 * An in-memory {@link Provider} for tests. Backed by a nested map:
 * `{ [environment]: { [path]: { [key]: value } } }`.
 */
export class FakeProvider implements Provider {
  reads = 0;
  peeks = 0;

  constructor(
    readonly id: string,
    private readonly data: Record<
      string,
      Record<string, Record<string, string>>
    >
  ) {}

  private folder(environment: string, path: string): Record<string, string> {
    return this.data[environment]?.[path] ?? {};
  }

  read(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Record<string, string>> {
    this.reads++;
    const folder = this.folder(environment, path);
    const out: Record<string, string> = {};
    for (const key of keys) {
      if (Object.hasOwn(folder, key)) out[key] = folder[key] as string;
    }
    return Promise.resolve(out);
  }

  peek(
    environment: string,
    path: string,
    keys: string[]
  ): Promise<Set<string>> {
    this.peeks++;
    const folder = this.folder(environment, path);
    return Promise.resolve(new Set(keys.filter((k) => Object.hasOwn(folder, k))));
  }
}
