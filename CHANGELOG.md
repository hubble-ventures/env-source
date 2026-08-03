# Changelog

## Unreleased

- **1Password is now a provider.** Declare `# onepassword` in a manifest and a
  `[providers.onepassword]` block in `env-source.toml`. Paths address an item
  (`/Engineering/stripe-{env}`, optionally `/vault/item/section`, or `/item` with
  a configured vault), `{env}` expands to the environment being resolved, and the
  declared keys are field names within the item.

  Reads go through the official SDK (`@1password/sdk`) rather than the `op` CLI —
  no binary on `PATH`, and one adapter covers both lanes: the desktop app locally
  (the client is built on first read, so `list` and `diff` never prompt) and a
  service account token (`OP_SERVICE_ACCOUNT_TOKEN`) in CI. Each item is read
  once and memoised per environment and path, for the same reason the Infisical
  CLI lane reads per folder: 1Password meters per request, and the per-account
  ceiling is 1,000 reads/24h outside Business plans.

  Two limits are worth knowing. The SDK is an **optional peer dependency** —
  `npm install @1password/sdk` in a workspace that uses this provider, including
  the GitHub Action, which does not bundle it. And **CI holds a long-lived
  credential**: 1Password's workload-identity (OIDC) auth is in public preview
  and not wired up, so there is no equivalent of the Infisical OIDC lane yet.

## 0.4.0

A pull in a monorepo that keeps worktrees inside itself issued ~910 Infisical
requests to resolve 74 declared keys, tripped `429 Too Many Requests`, and wrote
`.env.secrets` into eleven checkouts on unrelated branches. Three defects
compounded; all three are fixed, and the two selection changes are visible enough
to call out.

- **Discovery stops at another checkout.** Any directory holding a `.git` entry
  — a linked worktree, a submodule, a nested clone — is no longer descended
  into. Manifests inside a submodule are no longer discovered by the parent
  workspace; pull them from the submodule's own workspace instead.
- **A manifest id must identify exactly one manifest.** The leaf-name shorthand
  (`postgres` for `infra/postgres`) previously matched every same-named
  directory, so `pull scripts` wrote secrets to eleven paths nobody named. An
  exact id always wins; an ambiguous shorthand now fails and asks for the full
  id, and an id that matches nothing fails instead of quietly selecting none.
- **The Infisical CLI lane reads a folder once, not once per key.** `infisical
  secrets get <KEY>` resolves server-side to the *folder* endpoint and filters
  client-side, so asking per key downloaded the whole folder once per key. Each
  folder is now read once with `infisical export` — memoised per environment and
  path — and the declared keys selected from it: strictly less data over the
  wire, and identical results. Only declared keys are ever returned, an absent
  key stays absent, and malformed CLI output is retried rather than read as an
  empty folder. **The REST/OIDC lane is unchanged** — `/secrets/raw/{key}` is a
  genuine single-secret endpoint, so its per-key reads really are least
  privilege. See "Least privilege" in the README for what each lane buys.
- `validate` builds each provider once per run instead of once per manifest, so
  manifests sharing a vault folder no longer re-read it (and the CI lane no
  longer repeats the OIDC login per manifest).

## 0.3.1

- Release-automation shakeout: `release.yml` now auto-moves the `v1` tag and
  creates a GitHub Release after publishing. No library or CLI changes.

## 0.3.0

Sticky decorators — a decorator now applies to every assignment below it, so you
declare a provider and path once per group instead of repeating them per key.

- **Sticky provider / path / environments**: a decorator block carries down to
  every following assignment until the next decorator changes it.
- **Blank lines are cosmetic** — they no longer end a group (removes the
  whitespace-significance footgun).
- **`# literal`** resets the provider context so the keys below are literals
  (literals also work at the top of a file, before any decorator).
- **Source-key aliases are one-shot** — a bare `#  SOURCE_KEY` line aliases only
  the next key, and never leaks into later sticky keys.
- **Provider vs. source-key disambiguation**: the parser is given the provider
  ids from `env-source.toml`, so a container key that is a lowercase word
  (`token`, `secret`) is read as a source key, not mistaken for a provider.
- **`migrate`** emits the compact grouped form.
- Fully backward compatible: existing (repeated-block) manifests parse identically.

## 0.2.2

- Fix `migrate`: nested folder blocks in a legacy `secrets.json` (e.g.
  `apple → paddlesup → [KEYS]`) now flatten into a joined container path
  (`/apple/paddlesup`) with one valid assignment per key. Previously the nested
  object was mistaken for an alias and the key list was emitted as a single
  comma-mashed (invalid) variable name.

## 0.2.1

- First release published via npm OIDC trusted publishing (provenance-attested).
- Normalize the `bin` path to `dist/cli.js` (silences an npm 11 auto-correct warning).
- Release workflow triggers on semver tags only, so moving the `v1` Action tag
  never re-triggers a publish.

## 0.2.0

- **Provider fallback chains**: a variable can list several provider sources,
  tried in order until one has the key, then the default. A source-less
  assignment is a literal. (The compiled model is now an ordered `sources` list.)
- **Infisical auth is CLI-local / OIDC-CI only**: locally, shells the Infisical
  CLI (`infisical login` session — no token handled); in CI, GitHub OIDC. Dropped
  `INFISICAL_TOKEN` and Universal Auth.
- **Least-privilege reads**: both lanes fetch exactly the declared keys, one
  request per key — no folder listing or export ever crosses the wire. References
  are expanded and imports followed server-side, per key. All reads (REST and
  CLI) retry with backoff. `peek` checks existence by status alone, never parsing
  the value body.
- **`pull` writes secrets atomically at mode 0600** (was a plaintext 0644 write).
- **`run`**: resolve and exec a command with vars injected into its environment —
  secrets never touch disk (`env-source run -- npm run dev`).
- **`migrate`**: convert a legacy infisicml `secrets.json` to `.env.source`
  (+ a `.env.<profile>.source` per profile); warns on un-modeled `optionalKeys`/`ci`.
- **Profiles**: `--profile <name>` loads a sibling `.env.<name>.source` where present.
- **`validate --check-values`**: flag present-but-empty required values.

## 0.1.0

Initial release.

- `.env.source` manifest format: dotenv with decorators (provider, environments,
  container path, source-key alias) and optional fallback defaults.
- `env-source.toml` root config for non-secret provider context.
- Pure core: `parse → compile → materialize`, plus structural + provider-peek
  `validate`, over a pluggable `Provider` interface.
- Infisical provider with least-privilege per-key reads and a value-free `peek`.
- `diff`: compare the manifest surface against a git ref (variables
  added/removed/re-sourced) without reading secret values — a CLI command and an
  action mode that posts a sticky PR comment + job summary and can gate the PR.
- CLI (`pull`, `validate`, `diff`, `list`) and a bundled GitHub Action that loads
  secrets into the job environment via OIDC.
