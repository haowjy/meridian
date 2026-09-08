/** Validation and canonical target extraction for wikilink-valued hrefs. */

export function wikilinkTarget(href: string): string | null {
  if (!href.startsWith("[[") || !href.endsWith("]]")) return null;
  const rawTarget = href.slice(2, -2);
  if (/[\t\r\n[\]|]/.test(rawTarget)) return null;
  const target = rawTarget.trim();
  return target.length > 0 ? target : null;
}

/** Plain display text is opaque prose, not nested Markdown. Escape only wire delimiters. */
export function formatWikilink(target: string, displayText = target): string {
  return displayText === target
    ? `[[${target}]]`
    : `[[${target}|${displayText.replace(/[\\\]|]/g, "\\$&")}]]`;
}
