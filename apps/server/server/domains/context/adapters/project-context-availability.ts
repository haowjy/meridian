/** Drizzle project-final identity lookup and global availability watermarks. */
import { randomUUID } from "node:crypto";
import type {
  CatalogScope,
  ProjectContextAuthority,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { PROJECT_CONTEXT_AVAILABILITY_MAX_IDS } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contextAvailabilityGeneration,
  contextAvailabilityHeads,
  contextSources,
  documents,
  folders,
  projects,
  works,
} from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  getDrizzleTransactionLocal,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "../../../shared/drizzle-transaction.js";
import type {
  ProjectContextAvailabilityMutationPort,
  ProjectContextAvailabilityPort,
} from "../ports/project-context-availability.js";
import { mapAuthoritativeFile } from "./catalog-file-mapper.js";

const ADVANCE_STATE = {};
type AdvanceState = { generation: bigint; keys: Set<string> };

export function normalizeAvailabilityDocumentIds(documentIds: readonly string[]): string[] {
  const ids = [...new Set(documentIds)];
  if (ids.length > PROJECT_CONTEXT_AVAILABILITY_MAX_IDS) {
    throw new RangeError(
      `documentIds must contain at most ${PROJECT_CONTEXT_AVAILABILITY_MAX_IDS} distinct IDs`,
    );
  }
  return ids;
}

function projectKey(projectId: string) {
  return `project:${projectId}`;
}
function userKey(userId: string) {
  return `user:${userId}`;
}

export function createDrizzleProjectContextAvailability(
  db: Database,
): ProjectContextAvailabilityPort & ProjectContextAvailabilityMutationPort {
  return {
    async advance(input) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db) as Database;
        const requested = new Set([
          ...input.projectIds.map(projectKey),
          ...input.userIds.map(userKey),
        ]);
        let state = getDrizzleTransactionLocal<AdvanceState>(ADVANCE_STATE);
        if (!state) {
          const result = await tx.execute<{ generation: string }>(
            sql`select nextval(${sql.raw(`'${contextAvailabilityGeneration.seqName}'`)})::text as generation`,
          );
          const value = result[0]?.generation;
          if (!value) throw new Error("Failed to allocate availability generation");
          state = { generation: BigInt(value), keys: new Set() };
          setDrizzleTransactionLocal(ADVANCE_STATE, state);
        }
        const missing = [...requested].filter((key) => !state?.keys.has(key)).sort();
        if (missing.length > 0) {
          await tx
            .insert(contextAvailabilityHeads)
            .values(missing.map((authorityKey) => ({ authorityKey, generation: state.generation })))
            .onConflictDoUpdate({
              target: contextAvailabilityHeads.authorityKey,
              set: { generation: state.generation, updatedAt: new Date() },
            });
          for (const key of missing) state.keys.add(key);
        }
        return String(state.generation);
      });
    },

    async lookup(input, actor) {
      const ids = normalizeAvailabilityDocumentIds(input.documentIds);
      return runInRootDrizzleTransaction(
        db,
        async () => {
          const tx = currentDrizzleDb(db) as Database;
          const [requestProject] = await tx
            .select({ id: projects.id, userId: projects.userId, deletedAt: projects.deletedAt })
            .from(projects)
            .where(eq(projects.id, input.projectId))
            .limit(1);
          if (!requestProject || requestProject.userId !== actor.userId) {
            throw new Error("Project not found");
          }
          const headRows = await tx
            .select()
            .from(contextAvailabilityHeads)
            .where(
              inArray(contextAvailabilityHeads.authorityKey, [
                projectKey(input.projectId),
                userKey(actor.userId),
              ]),
            );
          const head = new Map(headRows.map((row) => [row.authorityKey, row.generation]));
          const projectGeneration = head.get(projectKey(input.projectId)) ?? 0n;
          const checkedGeneration = String(
            [projectGeneration, head.get(userKey(actor.userId)) ?? 0n].reduce((a, b) =>
              a > b ? a : b,
            ),
          );
          if (ids.length === 0) {
            return { projectId: input.projectId, resolutionId: randomUUID(), resolutions: [] };
          }
          const rows = await tx
            .select({
              document: documents,
              source: contextSources,
              sourceProject: projects,
              work: works,
            })
            .from(documents)
            .leftJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
            .leftJoin(projects, eq(contextSources.projectId, projects.id))
            .leftJoin(works, eq(contextSources.workId, works.id))
            .where(inArray(documents.id, ids as never));
          const byId = new Map(rows.map((row) => [row.document.id, row]));
          const sourceIds = [
            ...new Set(rows.flatMap((row) => (row.source ? [row.source.id] : []))),
          ];
          const folderRows = sourceIds.length
            ? await tx
                .select()
                .from(folders)
                .where(inArray(folders.contextSourceId, sourceIds as never))
            : [];
          const foldersById = new Map(folderRows.map((folder) => [folder.id, folder]));

          const resolutions: ProjectContextIdentityResolution[] = ids.map((documentId) => {
            const row = byId.get(documentId);
            if (!row) return { kind: "not-visible", documentId, checkedGeneration } as never;
            const { document, source, sourceProject, work } = row;
            if (!source) {
              return {
                kind: "indeterminate",
                documentId,
                checkedGeneration,
                reason: "identity_inconsistent",
              } as never;
            }
            let scope: CatalogScope;
            let authority: ProjectContextAuthority;
            let generation = String(projectGeneration);
            const belongsToRequestProject = source.projectId === input.projectId;
            const isActorUserSource =
              source.slug === "user" &&
              sourceProject?.isPersonal === true &&
              sourceProject.userId === actor.userId;
            if (source.workId) {
              if (!work || work.projectId !== input.projectId) {
                return { kind: "not-visible", documentId, checkedGeneration } as never;
              }
              const workSlug = work.slug as never;
              scope = { kind: "work", projectId: input.projectId, workId: work.id } as never;
              authority = {
                kind: "work",
                projectId: input.projectId,
                workId: work.id,
                workSlug,
              } as never;
            } else if (isActorUserSource) {
              scope = { kind: "user", userId: actor.userId } as never;
              authority = { kind: "user", userId: actor.userId } as never;
              generation = checkedGeneration;
            } else if (!belongsToRequestProject) {
              return { kind: "not-visible", documentId, checkedGeneration } as never;
            } else if (source.slug === "scratch" || source.slug === "uploads") {
              scope = { kind: "none", projectId: input.projectId } as never;
              authority = { kind: "none", projectId: input.projectId } as never;
            } else {
              scope = { kind: "project", projectId: input.projectId } as never;
              authority = { kind: "project", projectId: input.projectId } as never;
            }
            if (requestProject.deletedAt) {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "project_deleted",
              } as never;
            }
            if (work?.deletedAt) {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "work_deleted",
              } as never;
            }
            if (work?.status === "archived") {
              return {
                kind: "authority-unavailable",
                documentId,
                generation,
                authority,
                reason: "work_archived",
              } as never;
            }
            if (document.deletedAt || source.deletedAt) {
              return { kind: "deleted", documentId, generation, lastAuthority: authority } as never;
            }
            const parentPath: string[] = [];
            const visited = new Set<string>();
            let folderId = document.folderId;
            while (folderId) {
              if (visited.has(folderId)) {
                return {
                  kind: "indeterminate",
                  documentId,
                  checkedGeneration,
                  reason: "identity_inconsistent",
                } as never;
              }
              visited.add(folderId);
              const folder = foldersById.get(folderId);
              if (!folder || folder.contextSourceId !== source.id || folder.deletedAt) {
                return {
                  kind: "indeterminate",
                  documentId,
                  checkedGeneration,
                  reason: "identity_inconsistent",
                } as never;
              }
              parentPath.unshift(folder.name);
              folderId = folder.parentId;
            }
            try {
              return {
                kind: "available",
                documentId,
                generation,
                authority,
                entry: mapAuthoritativeFile({
                  document,
                  scope,
                  scheme: source.slug as never,
                  workId: work?.id ?? null,
                  workSlug: work?.slug ?? null,
                  parentPath,
                }),
              } as never;
            } catch {
              return {
                kind: "indeterminate",
                documentId,
                checkedGeneration,
                reason: "identity_inconsistent",
              } as never;
            }
          });
          return { projectId: input.projectId, resolutionId: randomUUID(), resolutions } as never;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
