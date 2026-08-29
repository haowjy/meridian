/** PostgreSQL proof for project-final lookup authority and watermark atomicity. */
import { createDb, type Database } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextSources,
  documents,
  folders,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../test-support/rollback-test-database.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project context availability (postgres)", () => {});
} else {
  describe("project context availability (postgres)", () => {
    const USER = "00000000-0000-4000-8000-000000000911";
    const OTHER = "00000000-0000-4000-8000-000000000912";
    const PROJECT = "00000000-0000-4000-8000-000000000913";
    const FOREIGN_PROJECT = "00000000-0000-4000-8000-000000000914";
    const PERSONAL = "00000000-0000-4000-8000-000000000915";
    const PROJECT_SOURCE = "00000000-0000-4000-8000-000000000916";
    const NONE_SOURCE = "00000000-0000-4000-8000-000000000917";
    const WORK_SOURCE = "00000000-0000-4000-8000-000000000918";
    const USER_SOURCE = "00000000-0000-4000-8000-000000000919";
    const FOREIGN_SOURCE = "00000000-0000-4000-8000-000000000920";
    const WORK = "00000000-0000-4000-8000-000000000921";
    const DOCS = [
      "00000000-0000-4000-8000-000000000922",
      "00000000-0000-4000-8000-000000000923",
      "00000000-0000-4000-8000-000000000924",
      "00000000-0000-4000-8000-000000000925",
      "00000000-0000-4000-8000-000000000926",
    ] as const;
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });

    async function seed(db: Database = database.current) {
      await db
        .insert(users)
        .values([
          conformanceUserValues(USER, "availability-user"),
          conformanceUserValues(OTHER, "availability-other"),
        ]);
      await db.insert(projects).values([
        { id: PROJECT, userId: USER, name: "Project", slug: "project" },
        { id: FOREIGN_PROJECT, userId: OTHER, name: "Foreign", slug: "foreign" },
        { id: PERSONAL, userId: USER, name: "Personal", slug: "personal", isPersonal: true },
      ]);
      await db.insert(works).values({
        id: WORK,
        projectId: PROJECT,
        createdByUserId: USER,
        name: "Draft",
        slug: "draft",
      });
      await db.insert(contextSources).values([
        { id: PROJECT_SOURCE, projectId: PROJECT, name: "Manuscript", slug: "manuscript" },
        { id: NONE_SOURCE, projectId: PROJECT, name: "Scratch", slug: "scratch" },
        { id: WORK_SOURCE, workId: WORK, scope: "work", name: "Work scratch", slug: "scratch" },
        { id: USER_SOURCE, projectId: PERSONAL, name: "User", slug: "user" },
        { id: FOREIGN_SOURCE, projectId: FOREIGN_PROJECT, name: "Foreign", slug: "manuscript" },
      ]);
      await db.insert(documents).values(
        DOCS.map((id, index) => ({
          id,
          contextSourceId:
            [PROJECT_SOURCE, NONE_SOURCE, WORK_SOURCE, USER_SOURCE, FOREIGN_SOURCE][index] ??
            PROJECT_SOURCE,
          name: `doc-${index}`,
          extension: "md",
        })),
      );
      return db;
    }

    it("resolves every requested authority and does not disclose foreign or unknown identities", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      await catalog.refreshSources([PROJECT_SOURCE, NONE_SOURCE, WORK_SOURCE, USER_SOURCE]);
      const result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [...DOCS, DOCS[0]] as never },
        { userId: USER },
      );
      expect(result.resolutions).toHaveLength(5);
      expect(result.resolutions.map((item) => item.kind)).toEqual([
        "available",
        "available",
        "available",
        "available",
        "not-visible",
      ]);
      expect(
        result.resolutions
          .slice(0, 4)
          .map((item) => (item.kind === "available" ? item.authority.kind : "wrong")),
      ).toEqual(["project", "none", "work", "user"]);
      const unknown = await availability.lookup(
        {
          projectId: PROJECT as never,
          documentIds: ["00000000-0000-4000-8000-999999999999"] as never,
        },
        { userId: USER },
      );
      expect({ ...result.resolutions[4], documentId: "same" }).toEqual({
        ...unknown.resolutions[0],
        documentId: "same",
      });
      await expect(
        availability.lookup({ projectId: PROJECT as never, documentIds: [] }, { userId: OTHER }),
      ).rejects.toThrow("Project not found");
    });

    it("advances affected heads once and rollback publishes no watermark", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const first = await runInDrizzleTransaction(db, async () => {
        const a = await availability.advance({ projectIds: [PROJECT], userIds: [USER] });
        const b = await availability.advance({ projectIds: [PROJECT], userIds: [USER] });
        expect(b).toBe(a);
        return a;
      });
      const before = await db.select().from(contextAvailabilityHeads);
      expect(before).toHaveLength(2);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await availability.advance({ projectIds: [FOREIGN_PROJECT], userIds: [] });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await db.select().from(contextAvailabilityHeads)).toEqual(before);
      const next = await availability.advance({ projectIds: [PROJECT], userIds: [] });
      expect(BigInt(next)).toBeGreaterThan(BigInt(first));
    });

    it("reads heads and identities from one repeatable-read snapshot across a committed move", async () => {
      assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
      const reader = createDb(DATABASE_URL, { max: 1 });
      const writer = createDb(DATABASE_URL, { max: 1 });
      await seed(reader);
      const initialGeneration = await createDrizzleProjectContextAvailability(reader).advance({
        projectIds: [PROJECT],
        userIds: [],
      });

      let announceDocumentLock: (() => void) | undefined;
      const documentLockHeld = new Promise<void>((resolve) => {
        announceDocumentLock = resolve;
      });

      try {
        const mutation = runInDrizzleTransaction(writer, async () => {
          const tx = currentDrizzleDb(writer) as Database;
          await tx.execute(sql`lock table documents in access exclusive mode`);
          announceDocumentLock?.();
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const result = await tx.execute<{ blocked: boolean }>(sql`
              select exists (
                select 1
                from pg_locks
                where relation = 'documents'::regclass
                  and not granted
              ) as blocked
            `);
            if (result[0]?.blocked) {
              await tx
                .update(documents)
                .set({ contextSourceId: WORK_SOURCE })
                .where(eq(documents.id, DOCS[0]));
              return createDrizzleProjectContextAvailability(writer).advance({
                projectIds: [PROJECT],
                userIds: [],
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("Lookup did not reach the post-head document-read barrier");
        });
        await documentLockHeld;
        const lookup = createDrizzleProjectContextAvailability(reader).lookup(
          { projectId: PROJECT as never, documentIds: [DOCS[0]] as never },
          { userId: USER },
        );
        const newGeneration = await mutation;

        await expect(lookup).resolves.toMatchObject({
          resolutions: [
            {
              kind: "available",
              generation: initialGeneration,
              authority: { kind: "project", projectId: PROJECT },
            },
          ],
        });
        await expect(
          createDrizzleProjectContextAvailability(reader).lookup(
            { projectId: PROJECT as never, documentIds: [DOCS[0]] as never },
            { userId: USER },
          ),
        ).resolves.toMatchObject({
          resolutions: [
            {
              kind: "available",
              generation: newGeneration,
              authority: { kind: "work", projectId: PROJECT, workId: WORK },
            },
          ],
        });
      } finally {
        await truncateDrizzleTables(reader, [users]);
        await Promise.all([reader.close(), writer.close()]);
      }
    });

    it("returns deleted and unavailable Work/project authority from tombstones", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const generation = await availability.advance({ projectIds: [PROJECT], userIds: [] });
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, DOCS[0]));
      await db.update(works).set({ status: "archived" }).where(eq(works.id, WORK));
      let result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [DOCS[0], DOCS[2]] as never },
        { userId: USER },
      );
      expect(result.resolutions).toMatchObject([
        { kind: "deleted", generation },
        { kind: "authority-unavailable", reason: "work_archived", generation },
      ]);
      await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, PROJECT));
      result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [DOCS[1]] as never },
        { userId: USER },
      );
      expect(result.resolutions[0]).toMatchObject({
        kind: "authority-unavailable",
        reason: "project_deleted",
      });
    });

    it("classifies internal and inconsistent identities before any destructive outcome", async () => {
      const db = await seed();
      const evidence = createInMemoryEventSink();
      const manifestId = "00000000-0000-4000-8000-000000000927";
      await db.insert(documents).values({
        id: manifestId,
        contextSourceId: PROJECT_SOURCE,
        kind: "manifest",
        name: ".manifest",
        extension: "json",
      });
      const availability = createDrizzleProjectContextAvailability(db, evidence);
      const result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [manifestId] as never },
        { userId: USER },
      );
      expect(result.resolutions).toEqual([
        expect.objectContaining({
          kind: "indeterminate",
          documentId: manifestId,
          reason: "identity_inconsistent",
        }),
      ]);
      expect(evidence.events).toEqual([
        expect.objectContaining({
          name: "ProjectContextIdentityInconsistent",
          payload: { documentId: manifestId, projectId: PROJECT },
        }),
      ]);
    });

    it("reports conflicting requested-project owners for live and tombstoned rows", async () => {
      const db = await seed();
      const evidence = createInMemoryEventSink();
      const availability = createDrizzleProjectContextAvailability(db, evidence);
      await db.execute(
        sql`alter table context_sources
              drop constraint context_sources_exactly_one_scope,
              drop constraint context_sources_scope_project_fk`,
      );
      await db
        .update(contextSources)
        .set({ workId: WORK })
        .where(eq(contextSources.id, PROJECT_SOURCE));

      const assertInconsistent = async () => {
        const result = await availability.lookup(
          { projectId: PROJECT as never, documentIds: [DOCS[0]] as never },
          { userId: USER },
        );
        expect(result.resolutions).toEqual([
          expect.objectContaining({
            kind: "indeterminate",
            documentId: DOCS[0],
            reason: "identity_inconsistent",
          }),
        ]);
      };
      await assertInconsistent();
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, DOCS[0]));
      await assertInconsistent();
      expect(evidence.events).toEqual([
        expect.objectContaining({
          name: "ProjectContextIdentityInconsistent",
          payload: { documentId: DOCS[0], projectId: PROJECT },
        }),
        expect.objectContaining({
          name: "ProjectContextIdentityInconsistent",
          payload: { documentId: DOCS[0], projectId: PROJECT },
        }),
      ]);
    });

    it("rejects invalid schemes, Work authority, scope pairing, and cross-source ancestry", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const assertIndeterminate = async (documentId: string) => {
        const result = await availability.lookup(
          { projectId: PROJECT as never, documentIds: [documentId] as never },
          { userId: USER },
        );
        expect(result.resolutions[0]).toMatchObject({
          kind: "indeterminate",
          documentId,
          reason: "identity_inconsistent",
        });
      };

      await db
        .update(contextSources)
        .set({ slug: "invalid-scheme" })
        .where(eq(contextSources.id, PROJECT_SOURCE));
      await assertIndeterminate(DOCS[0]);
      await db
        .update(contextSources)
        .set({ slug: "manuscript" })
        .where(eq(contextSources.id, PROJECT_SOURCE));

      await db
        .update(contextSources)
        .set({ slug: "manuscript" })
        .where(eq(contextSources.id, WORK_SOURCE));
      await assertIndeterminate(DOCS[2]);
      await db
        .update(contextSources)
        .set({ slug: "scratch" })
        .where(eq(contextSources.id, WORK_SOURCE));

      await db.execute(sql`alter table works drop constraint works_slug_valid`);
      await db.update(works).set({ slug: "invalid slug" }).where(eq(works.id, WORK));
      await assertIndeterminate(DOCS[2]);

      const foreignFolder = "00000000-0000-4000-8000-000000000928";
      await db.insert(folders).values({
        id: foreignFolder,
        contextSourceId: FOREIGN_SOURCE,
        name: "foreign-parent",
      });
      await db.update(documents).set({ folderId: foreignFolder }).where(eq(documents.id, DOCS[0]));
      await assertIndeterminate(DOCS[0]);
    });
  });
}
