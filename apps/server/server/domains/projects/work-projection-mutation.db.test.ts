/** PostgreSQL barriers for the production Work projection publication owner. */

import { catalogScopeKey } from "@meridian/contracts/protocol";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branchWriteJournal,
  contextAvailabilityHeads,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  documentBranches,
  documents,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../test-support/rollback-test-database.js";
import { createDrizzleBranchStore } from "../collab/adapters/drizzle-branches.js";
import { createDrizzleDocumentProjectionEffects } from "../collab/adapters/drizzle-document-activity.js";
import { createBranchCriticalSections } from "../collab/domain/branch-critical-sections.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { createDrizzleProjectContextAvailability } from "../context/adapters/project-context-availability.js";
import { createDrizzleRepositories } from "../threads/adapters/drizzle/index.js";
import { createWorkProjectionMutation } from "./adapters/work-projection-mutation.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Work projection publication owner (postgres)", () => {});
} else {
  describe("Work projection publication owner (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000901";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000902";
    const WORK_ID = "00000000-0000-4000-8000-000000000903";
    const THREAD_ID = "00000000-0000-4000-8000-000000000904";
    const TURN_ID = "00000000-0000-4000-8000-000000000905";
    const SECOND_WORK_ID = "00000000-0000-4000-8000-000000000906";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000907";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000908";
    const BRANCH_ID = "branch_work_projection_owner";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });

    async function fixture() {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "work-projection"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Projection project",
        slug: "projection-project",
      });
      await db.insert(works).values({
        id: WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Projection work",
        slug: "projection-work",
      });
      await db.insert(works).values({
        id: SECOND_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "Unaffected work",
        slug: "unaffected-work",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        workId: WORK_ID,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
      });
      await db.insert(documents).values({
        id: DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(documentBranches).values({
        id: BRANCH_ID,
        documentId: DOCUMENT_ID,
        kind: "work_draft",
        workId: WORK_ID,
        state: Buffer.from([0]),
        stateVector: Buffer.from([0]),
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Projection thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(threadWorks).values({
        threadId: THREAD_ID,
        workId: WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      const projection = createWorkProjectionMutation({ db, availability, catalog });
      await catalog.refreshProject(PROJECT_ID);
      return { db, projection, catalog };
    }

    async function projectionState() {
      const db = database.current;
      const [work] = await db
        .select({ entityRevision: works.entityRevision, updatedAt: works.updatedAt })
        .from(works)
        .where(eq(works.id, WORK_ID));
      const [head] = await db
        .select({ generation: contextAvailabilityHeads.generation })
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${PROJECT_ID}`));
      const catalog = createDrizzleContextCatalog(db);
      const snapshot = await catalog.snapshot({ kind: "project", projectId: PROJECT_ID });
      const authority = snapshot.entries.find((entry) => entry.entryId === WORK_ID);
      return {
        entityRevision: work?.entityRevision,
        updatedAt: work?.updatedAt,
        availabilityGeneration: head?.generation,
        catalogEntityRevision:
          authority?.kind === "authority" && authority.authority.kind === "work"
            ? authority.entityRevision
            : undefined,
      };
    }

    it("commits turn activity, entity authority, catalog signal, and project head together", async () => {
      const { projection } = await fixture();
      const before = await projectionState();

      await createDrizzleRepositories(database.current, projection).turns.create({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "user",
      });

      const after = await projectionState();
      expect(after.updatedAt?.getTime()).toBeGreaterThan(before.updatedAt?.getTime() ?? 0);
      expect(after.entityRevision).toBe((before.entityRevision ?? 0n) + 1n);
      expect(BigInt(after.catalogEntityRevision ?? "0")).toBe(after.entityRevision);
      expect(after.availabilityGeneration).toBeGreaterThan(before.availabilityGeneration ?? 0n);
    });

    it("rolls turn activity and every authority signal back with its outer transaction", async () => {
      const { projection } = await fixture();
      const repos = createDrizzleRepositories(database.current, projection);
      const before = await projectionState();

      await expect(
        repos.transaction(async () => {
          await repos.turns.create({ id: TURN_ID, threadId: THREAD_ID, role: "user" });
          throw new Error("forced rollback");
        }),
      ).rejects.toThrow("forced rollback");

      await expect(projectionState()).resolves.toEqual(before);
      await expect(repos.turns.findById(TURN_ID)).resolves.toBeNull();
    });

    it("publishes document activity through the same atomic owner", async () => {
      const { projection } = await fixture();
      const effects = createDrizzleDocumentProjectionEffects(database.current, projection);
      const before = await projectionState();
      const at = new Date("2026-08-29T12:34:56.789Z");

      await effects.touchDocumentActivity({ documentId: DOCUMENT_ID, at });

      const after = await projectionState();
      expect(after.updatedAt).toEqual(at);
      expect(after.entityRevision).toBe((before.entityRevision ?? 0n) + 1n);
      expect(after.catalogEntityRevision).toBe(String(after.entityRevision));
      expect(after.availabilityGeneration).toBeGreaterThan(before.availabilityGeneration ?? 0n);
    });

    it("updates one authority row, one catalog revision, one wake, and one availability generation", async () => {
      const db = database.current;
      const wakes: unknown[] = [];
      await fixture();
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(
        db,
        {
          publish(hint) {
            wakes.push(hint);
          },
        },
        {
          availabilityMutations: availability,
        },
      );
      const measured = createWorkProjectionMutation({ db, availability, catalog });
      const scopeKey = catalogScopeKey({ kind: "project", projectId: PROJECT_ID });
      const [headBefore] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const [otherBefore] = await db
        .select({ entry: contextCatalogEntries.entry })
        .from(contextCatalogEntries)
        .where(
          and(
            eq(contextCatalogEntries.scopeKey, scopeKey),
            eq(contextCatalogEntries.entryId, SECOND_WORK_ID),
          ),
        );
      const sequenceBefore = await db.execute<{ last_value: string }>(
        sql`select last_value::text from context_availability_generation_seq`,
      );

      await runInDrizzleTransaction(db, async () => {
        await measured.touchWorks([WORK_ID]);
        await measured.touchWorks([WORK_ID]);
      });

      const [headAfter] = await db
        .select({ revision: contextCatalogScopeHeads.headRevision })
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const [otherAfter] = await db
        .select({ entry: contextCatalogEntries.entry })
        .from(contextCatalogEntries)
        .where(
          and(
            eq(contextCatalogEntries.scopeKey, scopeKey),
            eq(contextCatalogEntries.entryId, SECOND_WORK_ID),
          ),
        );
      const sequenceAfter = await db.execute<{ last_value: string }>(
        sql`select last_value::text from context_availability_generation_seq`,
      );
      expect(headAfter?.revision).toBe((headBefore?.revision ?? 0) + 1);
      expect(otherAfter?.entry).toEqual(otherBefore?.entry);
      expect(wakes).toHaveLength(1);
      expect(BigInt(sequenceAfter[0]?.last_value ?? "0")).toBe(
        BigInt(sequenceBefore[0]?.last_value ?? "0") + 1n,
      );
      expect((await projectionState()).entityRevision).toBe(2n);
    });

    it("advances pending authority only for distinct-count append, discard, redo, and push", async () => {
      const db = database.current;
      const { projection } = await fixture();
      const branches = createDrizzleBranchStore(
        db,
        undefined,
        createBranchCriticalSections(),
        projection,
      );
      const state = async () => {
        const value = await projectionState();
        return {
          entityRevision: value.entityRevision,
          availabilityGeneration: value.availabilityGeneration,
          catalogEntityRevision: value.catalogEntityRevision,
        };
      };
      const appendJournal = (updateMeta: unknown) =>
        branches.appendJournal?.({
          branchId: BRANCH_ID,
          generation: 1,
          updateData: new Uint8Array([1]),
          source: "agent",
          updateMeta,
        }) ?? Promise.reject(new Error("Drizzle branch journal append is unavailable"));

      const initial = await state();
      await appendJournal({ kind: "manifest_membership", documentId: DOCUMENT_ID });
      await expect(state()).resolves.toEqual(initial);

      await appendJournal({ kind: "edit" });
      const appended = await state();
      expect(appended.entityRevision).toBe((initial.entityRevision ?? 0n) + 1n);

      await appendJournal({ kind: "edit" });
      await expect(state()).resolves.toEqual(appended);

      await projection.mutatePendingBranches([BRANCH_ID], () =>
        db
          .update(branchWriteJournal)
          .set({ status: "discarded" })
          .where(eq(branchWriteJournal.branchId, BRANCH_ID))
          .then(() => undefined),
      );
      const discarded = await state();
      expect(discarded.entityRevision).toBe((appended.entityRevision ?? 0n) + 1n);

      await projection.mutatePendingBranches([BRANCH_ID], () =>
        db
          .update(branchWriteJournal)
          .set({ status: "active" })
          .where(
            and(
              eq(branchWriteJournal.branchId, BRANCH_ID),
              sql`${branchWriteJournal.updateMeta}->>'kind' = 'edit'`,
            ),
          )
          .then(() => undefined),
      );
      const redone = await state();
      expect(redone.entityRevision).toBe((discarded.entityRevision ?? 0n) + 1n);

      await projection.mutatePendingBranches([BRANCH_ID], () =>
        db
          .update(branchWriteJournal)
          .set({ status: "pushed" })
          .where(eq(branchWriteJournal.branchId, BRANCH_ID))
          .then(() => undefined),
      );
      const pushed = await state();
      expect(pushed.entityRevision).toBe((redone.entityRevision ?? 0n) + 1n);
    });
  });
}
