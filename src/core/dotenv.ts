/**
 * Parse dotenv-format text into a `{ KEY: value }` map. Blank lines and `#`
 * comments are skipped; surrounding single/double quotes are stripped. Lenient
 * by design — it reads the `infisical export --format=dotenv` output.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Serialize a resolved `{ VAR: value }` map into `.env` text. Values that contain
 * whitespace or shell/dotenv-significant characters are JSON-quoted; everything
 * else is emitted bare. Keys are sorted for a stable, diff-friendly file.
 */
export function serializeDotenv(vars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(vars).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const needsQuotes = /[\s"'$`#\\]/.test(value) || value === "";
    lines.push(`${key}=${needsQuotes ? JSON.stringify(value) : value}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
