/** GET /api/projects/[projectId]/context/[scheme]/tree — project context file tree. */

import type { ContextAuthority } from "@meridian/contracts/context-uri";
import {
  type ProjectContextTreeDirectory,
  type ProjectContextTreeFile,
  type ProjectContextTreeNode,
  type ProjectContextTreeResponse,
  type ProjectContextTreeScheme,
  serializeTransport,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler } from "nitro/h3";
import {
  isWorkScopedBrowseScheme,
  workScopedBrowseUri,
} from "../../../../../../domains/context/browse-layer-scheme.js";
import { type FileEntry, schemeCapabilities } from "../../../../../../domains/context/index.js";
import type { ContextPort } from "../../../../../../domains/context/ports/context-port.js";
import { contextErrorToHttp, resolveContextRoute, toUri } from "./_helpers.js";

const ROOT_NAMES: Record<ProjectContextTreeScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  scratch: "Scratch",
  uploads: "Uploads",
  user: "User Files",
};

function rootUri(scheme: ProjectContextTreeScheme, authority: ContextAuthority): string {
  if (isWorkScopedBrowseScheme(scheme)) {
    if (authority.kind === "contextual") {
      throw createError({ statusCode: 500, message: "Missing resolved context authority" });
    }
    return workScopedBrowseUri(scheme, authority);
  }
  return toUri(scheme, "");
}

function pathFromUri(uri: string, root: string): string {
  if (!uri.startsWith(root))
    throw createError({ statusCode: 502, message: `Unexpected context URI: ${uri}` });
  const path = uri.slice(root.length).replace(/^\/+|\/+$/g, "");
  return path ? `/${path}` : "/";
}

function nameFromPath(path: string): string {
  if (path === "/") return "";
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function sortTree(nodes: ProjectContextTreeNode[]): ProjectContextTreeNode[] {
  return nodes.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
  );
}

async function listEntries(port: ContextPort, uri: string): Promise<FileEntry[]> {
  const result = await port.list(uri);
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value;
}

async function buildDirectory(
  port: ContextPort,
  root: string,
  uri: string,
  name: string,
): Promise<ProjectContextTreeDirectory> {
  const path = pathFromUri(uri, root);
  const entries = await listEntries(port, uri);
  const children: ProjectContextTreeNode[] = [];
  for (const entry of entries) {
    const entryPath = pathFromUri(entry.uri, root);
    if (entry.kind === "directory") {
      children.push(await buildDirectory(port, root, entry.uri, nameFromPath(entryPath)));
      continue;
    }
    if (!entry.documentId)
      throw createError({
        statusCode: 502,
        message: `Context file is missing persisted document id: ${entry.uri}`,
      });
    const file: ProjectContextTreeFile = {
      kind: "file",
      documentId: entry.documentId,
      name: nameFromPath(entryPath),
      path: entryPath,
      uri: entry.uri,
      sizeBytes: entry.sizeBytes,
      updatedAt: entry.updatedAt,
      readonly: entry.readonly,
      provisionalName: entry.provisionalName ?? false,
      ...(entry.editable
        ? { editable: true as const, filetype: entry.filetype, schemaType: entry.schemaType }
        : { editable: false as const, fileType: entry.fileType, mimeType: entry.mimeType }),
    };
    children.push(file);
  }
  return {
    kind: "dir",
    name,
    path,
    uri,
    readonly: entries.length > 0 ? entries.every((entry) => entry.readonly) : false,
    children: sortTree(children),
  };
}

export default defineEventHandler(async (event) => {
  const { projectId, scheme, authority, port } = await resolveContextRoute(event);
  return serializeTransport(await buildProjectContextTree({ projectId, scheme, authority, port }));
});

export async function buildProjectContextTree({
  projectId,
  scheme,
  authority,
  port,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  authority: ContextAuthority;
  port: ContextPort;
}): Promise<ProjectContextTreeResponse> {
  const root = rootUri(scheme, authority);
  const tree = await buildDirectory(port, root, root, ROOT_NAMES[scheme]);
  return { projectId, scheme, capabilities: schemeCapabilities(scheme), tree };
}
