import type { Issue } from "./types.js";

/**
 * Thrown when a manifest is structurally invalid or cannot be resolved. Carries
 * every {@link Issue} at once so a caller can report all problems in one pass
 * rather than surfacing them one failed run at a time.
 */
export class EnvSourceError extends Error {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    const summary =
      issues.length === 1
        ? issues[0]?.message
        : `${issues.length} problems in .env.source`;
    super(summary);
    this.name = "EnvSourceError";
    this.issues = issues;
  }
}
