/** Canonical transaction participant for every mutation visible in a Works snapshot. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBranches, works } from "@meridian/database/schema";
import { inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ProjectContextAvailabilityMutationPort } from "../../context/ports/project-context-availability.js";
import type { ContextCatalogLifecyclePort } from "../ports/context-catalog-lifecycle.js";

export type WorkProjectionMutation = {
  advanceProjects(projectIds: readonly string[]): Promise<void>;
  advanceWorks(workIds: readonly WorkId[], activityAt?: Date): Promise<void>;
  advanceBranches(branchIds: readonly string[]): Promise<void>;
};

export function createWorkProjectionMutation(input: {
  db: Database;
  availability: ProjectContextAvailabilityMutationPort;
  catalog: ContextCatalogLifecyclePort;
}): WorkProjectionMutation {
  async function publish(projectIds: readonly string[]): Promise<void> {
    const unique = [...new Set(projectIds)].sort();
    if (unique.length === 0) return;
    await input.availability.advance({ projectIds: unique, userIds: [] });
    for (const projectId of unique) await input.catalog.refreshProject(projectId);
  }

  return {
    advanceProjects: publish,
    async advanceBranches(branchIds) {
      const unique = [...new Set(branchIds)].sort();
      if (unique.length === 0) return;
      const rows = await currentDrizzleDb(input.db)
        .select({ workId: documentBranches.workId })
        .from(documentBranches)
        .where(inArray(documentBranches.id, unique));
      await this.advanceWorks(rows.flatMap(({ workId }) => (workId ? [workId] : [])));
    },
    async advanceWorks(workIds, activityAt) {
      const unique = [...new Set(workIds)].sort() as WorkId[];
      if (unique.length === 0) return;
      const rows = await currentDrizzleDb(input.db)
        .update(works)
        .set({
          entityRevision: sql`${works.entityRevision} + 1`,
          ...(activityAt ? { updatedAt: activityAt } : {}),
        })
        .where(inArray(works.id, unique))
        .returning({ projectId: works.projectId });
      await publish(rows.map(({ projectId }) => projectId));
    },
  };
}
