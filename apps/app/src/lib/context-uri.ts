/**
 * context-uri — canonical frontend parsing, formatting, and route adaptation for context URIs.
 */
import {
  canonicalContextUri,
  type ParsedContextUri,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

export type ContextUri = Omit<ParsedContextUri, "path" | "canonical"> & {
  path: string;
};

/** Parsed URI destination before the route owner supplies command ownership. */
export type ParsedContextUriTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

export type ActiveWorkHandle = { id: string; slug: string };

export function parseContextUri(uri: string): ContextUri | null {
  const parsed = parseUnifiedContextUri(uri);
  if (!parsed.ok) return null;
  return { ...parsed.value, path: formatContextPath(parsed.value.path) };
}

export function contextUriFromWritePath(path: string): string {
  const parsed = parseUnifiedContextUri(path);
  return parsed.ok
    ? parsed.value.canonical
    : canonicalContextUri("manuscript", path.replace(/^\/+/, ""));
}

export function contextRouteTargetFromUri(
  uri: string,
  activeWork: ActiveWorkHandle | null,
): ParsedContextUriTarget | null {
  const parsed = parseContextUri(uri);
  if (!parsed) return null;

  if (!isWorkScopedProjectContextScheme(parsed.scheme)) {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }

  // URI navigation never changes the displayed Work. A qualifier is routable
  // here only when it names that already-active Work.
  if (parsed.authority.kind === "none") {
    return { scheme: parsed.scheme, path: parsed.path, workId: null };
  }
  if (
    !activeWork ||
    (parsed.authority.kind === "work" && parsed.authority.workSlug !== activeWork.slug)
  ) {
    return null;
  }
  return { scheme: parsed.scheme, path: parsed.path, workId: activeWork.id };
}

export function canOpenContextUri(uri: string, activeWork: ActiveWorkHandle | null): boolean {
  return contextRouteTargetFromUri(uri, activeWork) !== null;
}

function formatContextPath(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}
