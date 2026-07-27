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
