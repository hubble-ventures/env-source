# Releasing

`env-source` ships two consumable artifacts from one repo:

- the **npm package** `@hubble-ventures/env-source` (library + `env-source` CLI), and
- the **GitHub Action** `hubble-ventures/env-source@v1` (the committed
  `action/index.cjs` bundle).

## Publishing auth: npm Trusted Publishing (OIDC) — no stored token

The release workflow publishes to npm using the workflow's **OIDC identity**, not
a stored `NPM_TOKEN` (`permissions: id-token: write` in `release.yml`). No secret
is ever needed — including for the first publish.

One-time setup (already done for this package):

1. **Configure the trusted publisher** on npmjs.com → the package → Settings →
   *Trusted Publisher* → GitHub Actions:
   - Organization/user: `hubble-ventures`
   - Repository: `env-source`
   - Workflow filename: `release.yml`
   - Environment: *(blank, or add one and gate the job on it)*

   npm lets you configure this *before* the package's first publish, so the very
   first release is published over OIDC too — no bootstrap token required.

Every release (including the first) then publishes via OIDC on a tag push. The
GitHub repo already exists at `github.com/hubble-ventures/env-source` with
`origin` set.

## Cutting a version

**The version is the tag** — there is no version-bump commit. `package.json` stays
at a `0.0.0` placeholder; the release workflow reads the version from the tag and
stamps it into `package.json` in the runner only (never committed) before
publishing.

To release:

1. Merge the work you want to ship to `main` via PR (CI gates it).
2. Tag a `main` commit and push the tag:
   ```bash
   git tag v0.3.2 origin/main       # pick the version; point at the commit to ship
   git push origin v0.3.2
   ```

That tag push triggers `.github/workflows/release.yml`, which does the rest
automatically:

- **stamps the version** from the tag into `package.json` (runner only),
- tests, builds, and `npm publish`es via OIDC,
- **moves the floating `v1` tag** to this release (so `uses:
  hubble-ventures/env-source@v1` picks it up), and
- **creates the GitHub Release** with auto-generated notes.

Nothing is written back to `main` — the pipeline only touches npm, the `v1` tag,
and the Release. Tags aren't branch-protected, so releasing needs no PR of its own.

> The `v1` tag is hard-coded, not derived from the version. A breaking change to
> the **action interface** (`action/action.yml` inputs) is a deliberate move to a
> new `v2` tag — update `release.yml` when that day comes.

## Notes

- CI (`.github/workflows/ci.yml`) fails if `action/index.cjs` is out of sync with
  `src/` — always `npm run build` after changing anything under `src/`.
- The npm package excludes `action/`; the Action is consumed from the git repo,
  not the tarball.
