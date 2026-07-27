/**
 * Normalize a provider container path into a canonical, leading-slash form:
 * `payments/stripe` and `/payments/stripe/` both become `/payments/stripe`.
 * The root container is `/`.
 *
 * Providers differ in what a "path" means (an Infisical folder, a 1Password
 * vault/item), but they share this shape so the manifest grammar stays uniform.
 */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}

/** A path is well-formed if it has no whitespace and no empty segments. */
export function isValidPath(path: string): boolean {
  return /^\/(?:[^/\s]+(?:\/[^/\s]+)*)?$/.test(normalizePath(path));
}
