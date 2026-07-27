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

Work on a branch, open a PR (CI gates it), and squash-merge to `main`. Then, on
`main`:

1. Bump the version and rebuild (the `version` script runs the build so `dist/`
   and `action/index.cjs` are fresh):
   ```bash
   npm version minor        # or patch / major
   ```
2. Commit the version bump + rebuilt bundle, tag, and push:
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push && git push --tags
   ```

The `vX.Y.Z` tag push triggers `.github/workflows/release.yml`, which then does
the rest automatically:

- tests, builds, and `npm publish`es via OIDC,
- **moves the floating `v1` tag** to this release (so `uses:
  hubble-ventures/env-source@v1` picks it up), and
- **creates the GitHub Release** with auto-generated notes.

> The `v1` tag is hard-coded, not derived from the version. A breaking change to
> the **action interface** (`action/action.yml` inputs) is a deliberate move to a
> new `v2` tag — update `release.yml` when that day comes.

## Notes

- CI (`.github/workflows/ci.yml`) fails if `action/index.cjs` is out of sync with
  `src/` — always `npm run build` after changing anything under `src/`.
- The npm package excludes `action/`; the Action is consumed from the git repo,
  not the tarball.
