import type {
  BindingChange,
  CompiledBinding,
  CompiledManifest,
  ManifestDelta,
  SettingChange,
} from "./types.js";

/**
 * Structural diff of two compiled manifests, keyed by emitted variable. Both
 * inputs are already normalized and sorted, so this is a stable set-diff — the
 * same two manifests always produce the same delta, which is what makes it safe
 * to gate a PR on. It compares only *where each variable comes from*; it never
 * reads a secret value.
 */
export function diffCompiled(
  base: CompiledManifest,
  head: CompiledManifest
): ManifestDelta {
  const baseByVar = new Map(base.bindings.map((b) => [b.targetVar, b]));
  const headByVar = new Map(head.bindings.map((b) => [b.targetVar, b]));

  const added: CompiledBinding[] = [];
  const removed: CompiledBinding[] = [];
  const changed: BindingChange[] = [];

  for (const [targetVar, headBinding] of headByVar) {
    const baseBinding = baseByVar.get(targetVar);
    if (!baseBinding) {
      added.push(headBinding);
    } else if (!sameSource(baseBinding, headBinding)) {
      changed.push({ targetVar, from: baseBinding, to: headBinding });
    }
  }
  for (const [targetVar, baseBinding] of baseByVar) {
    if (!headByVar.has(targetVar)) removed.push(baseBinding);
  }

  return {
    added: added.sort(byTarget),
    removed: removed.sort(byTarget),
    changed: changed.sort((a, b) => a.targetVar.localeCompare(b.targetVar)),
    settings: diffSettings(base, head),
  };
}

export function isEmptyDelta(delta: ManifestDelta): boolean {
  return (
    delta.added.length === 0 &&
    delta.removed.length === 0 &&
    delta.changed.length === 0 &&
    delta.settings.length === 0
  );
}

/** Render a delta as plain text (CLI). */
export function renderDeltaText(delta: ManifestDelta): string {
  if (isEmptyDelta(delta)) return "No manifest changes.";
  const lines: string[] = [];
  for (const s of delta.settings) lines.push(`~ ${s.field}: ${s.from} → ${s.to}`);
  for (const b of delta.added) lines.push(`+ ${b.targetVar}  ← ${sourceLabel(b)}`);
  for (const b of delta.removed) lines.push(`- ${b.targetVar}  ← ${sourceLabel(b)}`);
  for (const c of delta.changed) {
    lines.push(`~ ${c.targetVar}  ${sourceLabel(c.from)} → ${sourceLabel(c.to)}`);
  }
  return lines.join("\n");
}

/** Render a delta as GitHub-flavored Markdown (PR comment / job summary). */
export function renderDeltaMarkdown(
  delta: ManifestDelta,
  title: string
): string {
  if (isEmptyDelta(delta)) {
    return `### ${title}\n\n_No manifest changes._\n`;
  }
  const lines = [`### ${title}`, ""];
  if (delta.settings.length > 0) {
    lines.push("**Settings**", "");
    for (const s of delta.settings) {
      lines.push(`- \`${s.field}\`: \`${s.from}\` → \`${s.to}\``);
    }
    lines.push("");
  }
  lines.push("| Change | Variable | Source |", "| --- | --- | --- |");
  for (const b of delta.added) {
    lines.push(`| \`+ added\` | \`${b.targetVar}\` | \`${sourceLabel(b)}\` |`);
  }
  for (const b of delta.removed) {
    lines.push(`| \`- removed\` | \`${b.targetVar}\` | \`${sourceLabel(b)}\` |`);
  }
  for (const c of delta.changed) {
    lines.push(
      `| \`~ changed\` | \`${c.targetVar}\` | \`${sourceLabel(c.from)}\` → \`${sourceLabel(c.to)}\` |`
    );
  }
  lines.push(
    "",
    `_${delta.added.length} added · ${delta.removed.length} removed · ${delta.changed.length} changed_`,
    ""
  );
  return lines.join("\n");
}

/**
 * A binding is "the same source" when its resolution chain and fallback are
 * unchanged. Any edit to the ordered sources (provider, container path, source
 * key, or their order), the set of environments that keep a source in scope, or
 * the default alters what the emitted value is or where it comes from.
 */
function sameSource(a: CompiledBinding, b: CompiledBinding): boolean {
  return sourceLabel(a) === sourceLabel(b) && a.default === b.default;
}

/** Human-readable one-line description of where a binding's value comes from. */
function sourceLabel(b: CompiledBinding): string {
  if (b.sources.length === 0) {
    return b.default !== undefined ? "literal" : "unset";
  }
  return b.sources
    .map((s) => `${s.provider} ${s.path || "/"}:${s.sourceKey}`)
    .join(" → ");
}

function diffSettings(
  base: CompiledManifest,
  head: CompiledManifest
): SettingChange[] {
  const changes: SettingChange[] = [];
  // `environment` is the shared compile target and never differs between sides;
  // `output` can, when the config default changes.
  if (base.output !== head.output) {
    changes.push({ field: "output", from: base.output, to: head.output });
  }
  return changes;
}

function byTarget(a: CompiledBinding, b: CompiledBinding): number {
  return a.targetVar.localeCompare(b.targetVar);
}
