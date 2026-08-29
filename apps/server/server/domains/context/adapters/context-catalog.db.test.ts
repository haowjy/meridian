/** PostgreSQL proof for catalog transaction, replay, exclusion, and wake semantics. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, projects, users } from "@meridian/database/schema";
import { describe, expect, it, vi } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../test-support/rollback-test-database.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("context catalog (postgres)", () => {});
} else {
  describe("context catalog (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000801";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000803";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000804";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });

    it("publishes atomically, replays whole commits, and keeps failed hints nonthrowing", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      });
      const publish = vi.fn(async () => {
        throw new Error("offline");
      });
      const catalog = createDrizzleContextCatalog(db, { publish });
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const before = await catalog.snapshot(scope);

      await expect(
        runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db).insert(documents).values({
            id: DOCUMENT_ID,
            contextSourceId: SOURCE_ID,
            name: "chapter",
            extension: "md",
          });
          await catalog.refreshSources([SOURCE_ID]);
          expect(publish).not.toHaveBeenCalled();
        }),
      ).resolves.toBeUndefined();
      expect(publish).toHaveBeenCalledTimes(1);

      const replay = await catalog.changes(scope, before.cursor);
      expect(replay.kind).toBe("delta");
      if (replay.kind !== "delta") return;
      expect(replay.commits).toHaveLength(1);
      expect(replay.commits[0]?.changes.some((change) => change.operation === "upsert")).toBe(true);
      await expect(catalog.lookup({ scope, entryId: DOCUMENT_ID })).resolves.toMatchObject({
        entry: { kind: "file", entryId: DOCUMENT_ID, uri: "manuscript://chapter.md" },
      });
    });

    it("rolls catalog state back and excludes manifests and content-only changes", async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "catalog-rollback"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Catalog Project",
        slug: "catalog-project",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
      });
      const catalog = createDrizzleContextCatalog(db);
      const scope = { kind: "project", projectId: PROJECT_ID } as const;
      const before = await catalog.snapshot(scope);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db).insert(documents).values({
            id: DOCUMENT_ID,
            contextSourceId: SOURCE_ID,
            name: "manifest",
            extension: "json",
            kind: "manifest",
          });
          await catalog.refreshSources([SOURCE_ID]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const after = await catalog.snapshot(scope);
      expect(after.headRevision).toBe(before.headRevision);
      expect(after.entries.some((entry) => entry.entryId === DOCUMENT_ID)).toBe(false);
      const replay = await catalog.changes(scope, before.cursor);
      expect(replay).toMatchObject({ kind: "delta", commits: [] });
    });
  });
}
