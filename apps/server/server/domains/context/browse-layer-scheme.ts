/**
 * Browse-layer helpers for project context HTTP routes.
 * Project routes use the same scheme names as the unified ContextPort.
 */
import { type ContextAuthority, canonicalContextUri } from "@meridian/contracts/context-uri";
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  type WorkAuthorityScheme,
} from "@meridian/contracts/protocol";

export const isWorkScopedBrowseScheme = isWorkScopedProjectContextScheme;

/** Serialize the canonical authority selected by the project browse route. */
export function projectBrowseContextUri(
  scheme: ProjectContextTreeScheme,
  path: string,
  authority: ContextAuthority = { kind: "contextual" },
): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return isWorkScopedBrowseScheme(scheme)
    ? canonicalContextUri(scheme, normalized, authority)
    : canonicalContextUri(scheme, normalized);
}

export function workScopedBrowseUri(
  scheme: WorkAuthorityScheme,
  authority: Extract<ContextAuthority, { kind: "work" | "none" }>,
  path = "",
): string {
  return projectBrowseContextUri(scheme, path, authority);
}
