/** Canonical transaction participant for every mutation visible in a Works snapshot. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branchWriteJournal, documentBranches, works } from "@meridian/database/schema";
import { and, countDistinct, eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  getDrizzleTransactionLocal,
  runInDrizzleTransaction,
  setDrizzleTransactionLocal,
} from "../../../shared/drizzle-transaction.js";
import type { ProjectContextAvailabilityMutationPort } from "../../context/ports/project-context-availability.js";
import type { ContextCatalogLifecyclePort } from "../ports/context-catalog-lifecycle.js";

export type WorkProjectionMutation = {
  publishWorks(workIds: readonly WorkId[]): Promise<void>;
  touchWorks(workIds: readonly WorkId[], activityAt?: Date): Promise<void>;
  mutatePendingBranches<T>(branchIds: readonly string[], operation: () => Promise<T>): Promise<T>;
};

const PUBLICATION_STATE = {};
type PublicationState = { publishedWorkIds: Set<WorkId> };

export function createWorkProjectionMutation(input: {
  db: Database;
  availability: ProjectContextAvailabilityMutationPort;
  catalog: ContextCatalogLifecyclePort;
}): WorkProjectionMutation {
  function publicationState(): PublicationState {
    let state = getDrizzleTransactionLocal<PublicationState>(PUBLICATION_STATE);
    if (!state) {
      state = { publishedWorkIds: new Set() };
      setDrizzleTransactionLocal(PUBLICATION_STATE, state);
    }
    return state;
  }

  async function publish(workIds: readonly WorkId[]): Promise<void> {
    const state = publicationState();
    const unique = [...new Set(workIds)].sort() as WorkId[];
    const unpublished = unique.filter((workId) => !state.publishedWorkIds.has(workId));
    if (unpublished.length === 0) return;
    const rows = await currentDrizzleDb(input.db)
      .select({ id: works.id, projectId: works.projectId })
      .from(works)
      .where(inArray(works.id, unpublished));
    if (rows.length === 0) return;
    await input.availability.advance({
      projectIds: [...new Set(rows.map(({ projectId }) => projectId))].sort(),
      userIds: [],
    });
    await input.catalog.upsertWorkAuthorities(rows.map(({ id }) => id));
    for (const { id } of rows) state.publishedWorkIds.add(id as WorkId);
  }

  async function pendingCounts(workIds: readonly WorkId[]): Promise<Map<WorkId, number>> {
    if (workIds.length === 0) return new Map();
    const rows = await currentDrizzleDb(input.db)
      .select({ workId: documentBranches.workId, count: countDistinct(documentBranches.id) })
      .from(documentBranches)
      .innerJoin(
        branchWriteJournal,
        and(
          eq(branchWriteJournal.branchId, documentBranches.id),
          eq(branchWriteJournal.generation, documentBranches.generation),
          inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
        ),
      )
      .where(
        and(
          inArray(documentBranches.workId, workIds),
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
          sql`(${branchWriteJournal.updateMeta}->>'kind') is distinct from 'manifest_membership'
            or jsonb_typeof(${branchWriteJournal.updateMeta}->'documentId') is distinct from 'string'`,
        ),
      )
      .groupBy(documentBranches.workId);
    return new Map(
      rows.flatMap(({ workId, count }) =>
        workId === null ? [] : [[workId as WorkId, Number(count)] as const],
      ),
    );
  }

  const mutation: WorkProjectionMutation = {
    async publishWorks(workIds) {
      await runInDrizzleTransaction(input.db, () => publish(workIds));
    },
    async touchWorks(workIds, activityAt) {
      await runInDrizzleTransaction(input.db, async () => {
        const state = publicationState();
        const unique = [...new Set(workIds)].sort() as WorkId[];
        const untouched = unique.filter((workId) => !state.publishedWorkIds.has(workId));
        if (untouched.length === 0) return;
        const rows = await currentDrizzleDb(input.db)
          .update(works)
          .set({
            entityRevision: sql`${works.entityRevision} + 1`,
            ...(activityAt ? { updatedAt: activityAt } : {}),
          })
          .where(inArray(works.id, untouched))
          .returning({ id: works.id });
        await publish(rows.map(({ id }) => id as WorkId));
      });
    },
    async mutatePendingBranches(branchIds, operation) {
      return runInDrizzleTransaction(input.db, async () => {
        const unique = [...new Set(branchIds)].sort();
        if (unique.length === 0) return operation();
        const branchRows = await currentDrizzleDb(input.db)
          .select({ workId: documentBranches.workId })
          .from(documentBranches)
          .where(inArray(documentBranches.id, unique));
        const workIds = [
          ...new Set(branchRows.flatMap(({ workId }) => (workId ? [workId] : []))),
        ].sort() as WorkId[];
        const before = await pendingCounts(workIds);
        const result = await operation();
        const after = await pendingCounts(workIds);
        await mutation.touchWorks(
          workIds.filter((workId) => (before.get(workId) ?? 0) !== (after.get(workId) ?? 0)),
        );
        return result;
      });
    },
  };
  return mutation;
}
