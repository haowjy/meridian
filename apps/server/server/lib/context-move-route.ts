/** Plain-data orchestration for committing a writer-visible context identity. */

import type { MoveContextEntryResult } from "@meridian/contracts/protocol";
import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { projectBrowseContextUri } from "../domains/context/browse-layer-scheme.js";
import {
  type ContextPort,
  contextPortForProjectAuthorities,
  type ProjectContextFsScheme,
  parseUnifiedContextUri,
  type UnifiedContextPortFactory,
  type WorkScopedContextFsScheme,
} from "../domains/context/index.js";
import {
  type ProjectRepository,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import { contextErrorToHttp } from "./context-error-http.js";
import {
  parseContextMutationName,
  parseContextMutationPath,
} from "./context-mutation-validation.js";

export interface ContextMoveRouteDeps {
  projectRepo: ProjectRepository;
  workRepo: WorkRepository;
  contextPorts: UnifiedContextPortFactory;
}

type ProjectLocator = {
  scope: "project";
  scheme: ProjectContextFsScheme;
  path: string;
};

type WorkLocator = {
  scope: "work";
  scheme: WorkScopedContextFsScheme;
  workId: string;
  path: string;
};

type NoWorkLocator = {
  scope: "none";
  scheme: WorkScopedContextFsScheme;
  path: string;
};

export type ContextMoveLocator = ProjectLocator | NoWorkLocator | WorkLocator;

export interface ParsedContextMove {
  source: ContextMoveLocator;
  destination: ContextMoveLocator;
  name?: string;
}

function parseWorkId(raw: unknown, field: "sourceWorkId" | "destinationWorkId") {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw createError({ statusCode: 400, message: `\`${field}\` must be a non-empty string` });
  }
  return raw.trim();
}

function parseLocator(input: {
  scheme: unknown;
  path: string;
  workId: string | null;
  workIdField: "sourceWorkId" | "destinationWorkId";
}): ContextMoveLocator {
  if (!isProjectContextTreeScheme(input.scheme)) {
    throw createError({ statusCode: 400, message: "Context scheme is invalid" });
  }
  if (isWorkScopedProjectContextScheme(input.scheme)) {
    if (!input.workId) {
      return { scope: "none", scheme: input.scheme, path: input.path };
    }
    return {
      scope: "work",
      scheme: input.scheme as WorkScopedContextFsScheme,
      workId: input.workId,
      path: input.path,
    };
  }
  if (input.workId !== null) {
    throw createError({
      statusCode: 400,
      message: `\`${input.workIdField}\` is not valid for ${input.scheme}`,
    });
  }
  return { scope: "project", scheme: input.scheme as ProjectContextFsScheme, path: input.path };
}

export function parseContextMove(input: {
  sourceScheme: unknown;
  body: unknown;
}): ParsedContextMove {
  if (!input.body || typeof input.body !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const body = input.body as Record<string, unknown>;
  const sourcePath = parseContextMutationPath(body.path, "path");
  const destinationFolderPath = parseContextMutationPath(
    body.destinationFolderPath,
    "destinationFolderPath",
    { allowRoot: true },
  );
  let name: string | undefined;
  if (body.newName !== undefined) {
    name = parseContextMutationName(body.newName, "newName");
  }
  return {
    source: parseLocator({
      scheme: input.sourceScheme,
      path: sourcePath,
      workId: parseWorkId(body.sourceWorkId, "sourceWorkId"),
      workIdField: "sourceWorkId",
    }),
    destination: parseLocator({
      scheme: body.destinationScheme,
      path: destinationFolderPath,
      workId: parseWorkId(body.destinationWorkId, "destinationWorkId"),
      workIdField: "destinationWorkId",
    }),
    ...(name ? { name } : {}),
  };
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function locatorUri(
  locator: ContextMoveLocator,
  path = locator.path,
  qualifiedWorkSlugs?: ReadonlyMap<string, string>,
): string {
  if (locator.scope === "work") {
    const slug = qualifiedWorkSlugs?.get(locator.workId);
    if (slug) return `${locator.scheme}://@${slug}/${path}`;
    // A port already bound to this Work resolves contextual syntax without
    // serializing the internal ID as URI authority.
    return projectBrowseContextUri(locator.scheme, path);
  }
  if (locator.scope === "none") {
    return projectBrowseContextUri(locator.scheme, path, { kind: "none" });
  }
  return projectBrowseContextUri(locator.scheme, path);
}

export async function commitContextMove(input: {
  port: ContextPort;
  userId: string;
  move: ParsedContextMove;
  qualifiedWorkSlugs?: ReadonlyMap<string, string>;
}): Promise<MoveContextEntryResult> {
  const name = input.move.name ?? basename(input.move.source.path);
  const destinationPath = joinPath(input.move.destination.path, name);
  const result = await input.port.commitWriterLocation(
    locatorUri(input.move.source, input.move.source.path, input.qualifiedWorkSlugs),
    locatorUri(input.move.destination, destinationPath, input.qualifiedWorkSlugs),
    { origin: { type: "human", userId: input.userId } },
  );
  if (!result.ok) {
    if (result.error.code === "stale_source" || result.error.code === "stale_target") {
      return {
        status: "retry",
        reason: result.error.code === "stale_source" ? "stale-source" : "stale-target",
      };
    }
    if (result.error.code === "conflict") {
      const collision = parseUnifiedContextUri(result.error.uri);
      if (!collision.ok) contextErrorToHttp(collision.error);
      const authority = collision.value.authority;
      const workId =
        authority.kind === "work"
          ? [...(input.qualifiedWorkSlugs ?? [])].find(
              ([, slug]) => slug === authority.workSlug,
            )?.[0]
          : undefined;
      if (authority.kind === "work" && !workId) {
        throw createError({
          statusCode: 409,
          message: "Conflict authority is no longer available",
        });
      }
      return {
        status: "conflict",
        collision:
          authority.kind === "work"
            ? {
                scheme: collision.value.scheme as WorkScopedContextFsScheme,
                path: collision.value.path,
                authority: { kind: "work", workId: workId as WorkId },
              }
            : authority.kind === "none"
              ? {
                  scheme: collision.value.scheme as WorkScopedContextFsScheme,
                  path: collision.value.path,
                  authority: { kind: "none" },
                }
              : {
                  scheme: collision.value.scheme as ProjectContextFsScheme,
                  path: collision.value.path,
                  authority: { kind: "project" },
                },
      };
    }
    contextErrorToHttp(result.error);
  }
  return {
    status: "moved",
    scheme: input.move.destination.scheme,
    path: result.value.destinationPath,
    name: basename(result.value.destinationPath),
  };
}

export async function handleContextMoveRequest(
  deps: ContextMoveRouteDeps,
  input: { projectId: string; userId: string; sourceScheme: unknown; body: unknown },
): Promise<MoveContextEntryResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const move = parseContextMove({ sourceScheme: input.sourceScheme, body: input.body });
  const workIds = new Set(
    [move.source, move.destination]
      .filter((locator): locator is WorkLocator => locator.scope === "work")
      .map((locator) => locator.workId),
  );
  const primaryWorkId = move.source.scope === "work" ? move.source.workId : [...workIds][0];
  const works = await deps.workRepo.listByProject(input.projectId);
  const port = await contextPortForProjectAuthorities({
    deps: { contextPorts: deps.contextPorts, works: deps.workRepo },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId,
    projectWorks: works,
  });
  if (!port) throw createError({ statusCode: 404, message: "Work not found" });
  const qualifiedWorkSlugs = new Map(
    works.filter((work) => workIds.has(work.id)).map((work) => [work.id, work.slug]),
  );
  return commitContextMove({ port, userId: input.userId, move, qualifiedWorkSlugs });
}
