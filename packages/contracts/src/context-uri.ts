/** Shared, presentation-neutral derivation for canonical context URIs. */

/**
 * Derives a document title from the final URI/path segment.
 *
 * Context documents use the basename stem as their title. Callers own the
 * fallback because some server notices prefer a document id while writer-facing
 * surfaces use "Untitled document".
 */
export function documentTitleFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const segment = uri.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  return segment.replace(/\.[^.]+$/, "") || null;
}
