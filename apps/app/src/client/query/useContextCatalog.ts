/** React Query acquisition and legacy tree projection over one normalized ID cache. */
import type {
  CatalogScope,
  CatalogWakeHint,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { catalogScopeKey, classifyFiletype } from "@meridian/contracts/protocol";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  getContextCatalogChanges,
  getContextCatalogLookup,
  getContextCatalogSnapshot,
} from "@/client/api/projects-api";
import type {
  CatalogTreeDirectory,
  CatalogTreeFile,
  CatalogTreeProjection,
} from "@/client/query/context-catalog-projection";
import {
  type CatalogCacheView,
  ContextCatalogCache,
  catalogChildren,
} from "./context-catalog-cache";
import { projectQueryKeys } from "./project-query-keys";

const cache = new ContextCatalogCache();
const acquiredViews = new Map<string, CatalogCacheView>();

export function contextCatalogScope(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  workId: string | null,
): CatalogScope {
  if (scheme === "user") return { kind: "user", userId: "self" };
  if (scheme === "scratch" || scheme === "uploads") {
    return workId ? { kind: "work", projectId, workId } : { kind: "none", projectId };
  }
  return { kind: "project", projectId };
}

async function acquire(projectId: string, requestedScope: CatalogScope): Promise<CatalogCacheView> {
  const acquisitionKey = `${projectId}:${catalogScopeKey(requestedScope)}`;
  let view = acquiredViews.get(acquisitionKey);
  if (!view?.generation) {
    view = cache.replace(await getContextCatalogSnapshot(projectId, requestedScope));
    acquiredViews.set(acquisitionKey, view);
    return view;
  }
  for (let page = 0; page < 10; page += 1) {
    const changes = await getContextCatalogChanges(projectId, requestedScope, view.cursor);
    if (changes.kind === "reset-required") {
      view = cache.replace(await getContextCatalogSnapshot(projectId, requestedScope));
      acquiredViews.set(acquisitionKey, view);
      return view;
    }
    view = cache.apply(changes) ?? view;
    acquiredViews.set(acquisitionKey, view);
    if (!changes.hasMore) return view;
  }
  return view;
}

export function contextCatalogQueryOptions(projectId: string, scope: CatalogScope) {
  return queryOptions({
    queryKey: projectQueryKeys.contextCatalog(projectId, scope),
    queryFn: () => acquire(projectId, scope),
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

const ROOT_NAMES: Record<ProjectContextTreeScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  user: "User Files",
  scratch: "Scratch",
  uploads: "Uploads",
};

export function projectCatalogFile(
  entry: Extract<ReturnType<typeof catalogChildren>[number], { kind: "file" }>,
): CatalogTreeFile {
  const classification = classifyFiletype(entry.fileType);
  const base = {
    kind: "file" as const,
    documentId: entry.entryId,
    name: entry.name,
    path: `/${entry.path.join("/")}`,
    uri: entry.uri,
    provisionalName: entry.provisionalName,
  };
  if (classification.kind === "tracked") {
    return {
      ...base,
      editable: true,
      filetype: entry.fileType,
      schemaType: classification.schemaType,
    };
  }
  return {
    ...base,
    editable: false,
    fileType:
      classification.kind === "binary" || classification.kind === "custom"
        ? classification.fileType
        : "binary",
  };
}

export function projectCatalogTree(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  view: CatalogCacheView,
): CatalogTreeProjection {
  const source = [...view.entries.values()].find(
    (entry) => entry.kind === "source" && entry.scheme === scheme,
  );
  const rootUri = source?.kind === "source" ? source.uri : `${scheme}://`;
  const build = (
    parentId: string,
    name: string,
    path: string,
    uri: string,
  ): CatalogTreeDirectory => {
    const children: CatalogTreeDirectory["children"] = [];
    for (const entry of catalogChildren(view, parentId)) {
      if (entry.kind === "file") children.push(projectCatalogFile(entry));
      else if (entry.kind === "folder") {
        children.push(build(entry.entryId, entry.name, `/${entry.path.join("/")}`, entry.uri));
      }
    }
    return { kind: "dir", name, path, uri, children };
  };
  const tree =
    source?.kind === "source"
      ? build(source.entryId, ROOT_NAMES[scheme], "/", rootUri)
      : { kind: "dir" as const, name: ROOT_NAMES[scheme], path: "/", uri: rootUri, children: [] };
  return {
    projectId,
    scheme,
    capabilities: { writable: true, searchable: true, creatable: scheme !== "uploads" },
    tree,
  };
}

export async function fetchContextCatalogTree(
  queryClient: QueryClient,
  projectId: string,
  scheme: ProjectContextTreeScheme,
  workId: string | null,
): Promise<CatalogTreeProjection> {
  const scope = contextCatalogScope(projectId, scheme, workId);
  const view = await queryClient.fetchQuery(contextCatalogQueryOptions(projectId, scope));
  return projectCatalogTree(projectId, scheme, view);
}

export async function lookupContextCatalogFile(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  workId: string | null,
  lookup: { entryId: string } | { path: string },
) {
  const result = await getContextCatalogLookup(
    projectId,
    contextCatalogScope(projectId, scheme, workId),
    lookup,
  );
  return result.entry?.kind === "file" && result.entry.uri.startsWith(`${scheme}://`)
    ? projectCatalogFile(result.entry)
    : null;
}

export function useContextCatalogTree(
  projectId: string,
  scheme: ProjectContextTreeScheme,
  options: { enabled?: boolean; workId: string | null },
) {
  const scope = contextCatalogScope(projectId, scheme, options.workId);
  const query = useQuery({
    ...contextCatalogQueryOptions(projectId, scope),
    enabled: options.enabled ?? true,
  });
  const response = useMemo(
    () => (query.data ? projectCatalogTree(projectId, scheme, query.data) : null),
    [projectId, query.data, scheme],
  );
  return {
    tree: response?.tree ?? null,
    capabilities: response?.capabilities ?? null,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

export function useContextCatalogScope(projectId: string, scope: CatalogScope, enabled = true) {
  return useQuery({ ...contextCatalogQueryOptions(projectId, scope), enabled });
}

/** Duplicate-tolerant wake hint handler; the hint never mutates cache state itself. */
export function pullContextCatalogOnHint(
  queryClient: QueryClient,
  projectId: string,
  hint: CatalogWakeHint,
): void {
  const requestedScope: CatalogScope =
    hint.scope.kind === "user" ? { kind: "user", userId: "self" } : hint.scope;
  const view = acquiredViews.get(`${projectId}:${catalogScopeKey(requestedScope)}`);
  if (view?.headRevision === hint.headRevision) return;
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.contextCatalog(projectId, requestedScope),
  });
}
