/** PostgreSQL proof for project-final lookup authority and watermark atomicity. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextSources,
  documents,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../test-support/rollback-test-database.js";
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

    async function seed() {
      const db = database.current;
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
  });
}
