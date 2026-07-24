/**
 * Writer-facing names for context documents and folders shown in chat.
 *
 * This module turns tool addresses into story objects. It owns no lookup or
 * state: context URIs already carry the document basename and location.
 */
import { t } from "@lingui/core/macro";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import { schemeLabel } from "@/features/project/context/context-schemes";

const CONTEXT_SCHEMES = new Set<ProjectContextTreeScheme>([
  "manuscript",
  "kb",
  "scratch",
  "uploads",
  "user",
]);

type ParsedContextLocation = {
  scheme: ProjectContextTreeScheme;
  path: string;
};

function parseContextLocation(uriOrPath: string): ParsedContextLocation {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(uriOrPath);
  const candidate = match?.[1]?.toLowerCase();
  if (candidate && CONTEXT_SCHEMES.has(candidate as ProjectContextTreeScheme)) {
    return {
      scheme: candidate as ProjectContextTreeScheme,
      path: match?.[2] ?? "",
    };
  }
  return { scheme: "manuscript", path: uriOrPath };
}

export function isContextUri(value: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  return CONTEXT_SCHEMES.has(match?.[1]?.toLowerCase() as ProjectContextTreeScheme);
}

export type DocumentDisplayName = {
  title: string;
  qualifier?: string;
};

export function documentDisplayName(uriOrPath: string): DocumentDisplayName {
  const { scheme } = parseContextLocation(uriOrPath);
  const title = documentTitleFromUri(uriOrPath) ?? t`Untitled document`;
  return scheme === "manuscript" ? { title } : { title, qualifier: schemeLabel(scheme) };
}

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? schemeLabel(scheme);
}
