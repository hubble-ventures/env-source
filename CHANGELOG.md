# Changelog

## 0.2.0

- **Provider fallback chains**: a variable can list several provider sources,
  tried in order until one has the key, then the default. A source-less
  assignment is a literal. (The compiled model is now an ordered `sources` list.)
- **Infisical auth is CLI-local / OIDC-CI only**: locally, shells the Infisical
  CLI (`infisical login` session — no token handled); in CI, GitHub OIDC. Dropped
  `INFISICAL_TOKEN` and Universal Auth.
- **Read fidelity + resilience**: REST reads request folder imports and expand
  secret references (matching the UI); all reads (REST and CLI) retry with backoff.
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
- Infisical provider with token / Universal Auth / GitHub OIDC auth, `folder` or
  least-privilege `keys` reads, and value-free `peek`.
- `diff`: compare the manifest surface against a git ref (variables
  added/removed/re-sourced) without reading secret values — a CLI command and an
  action mode that posts a sticky PR comment + job summary and can gate the PR.
- CLI (`pull`, `validate`, `diff`, `list`) and a bundled GitHub Action that loads
  secrets into the job environment via OIDC.
