/** PostgreSQL coverage for nullable and concurrent thread Work rebinds. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  resetThreadWorkRaceFixture,
  THREAD_WORK_RACE,
} from "../test-support/thread-work-postgres-harness.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("nullable thread Work rebind (postgres)", () => {});
else
  describe("nullable thread Work rebind (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { eq } = await import("drizzle-orm");
    const { createDrizzleProjectWorkRepository } = await import("../../projects/index.js");
    const { createDrizzleRepositories } = await import("../adapters/drizzle/repositories.js");
    const { rebindThreadWork } = await import("./rebind-thread-work.js");
    const db = createDb(DATABASE_URL, { max: 4 });
    const repos = createDrizzleRepositories(db);
    const works = createDrizzleProjectWorkRepository({ db, hasUnreviewedDraft: async () => false });
    const ids = THREAD_WORK_RACE;
    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
      await db
        .update(schema.works)
        .set({ status: "active", archivedAt: null })
        .where(eq(schema.works.id, ids.targetWorkId));
    });
    afterAll(() => db.close());
    const rebind = (target: { kind: "none" } | { kind: "work"; workId: string }) =>
      repos.transaction(() =>
        rebindThreadWork(
          {
            threads: repos.threads,
            threadWorks: repos.threadWorks,
            works,
            obligations: repos.workContextDeliveries,
          },
          { threadId: ids.threadId, target } as never,
        ),
      );

    it("supports none to Work to none while retaining historical membership", async () => {
      await expect(rebind({ kind: "none" })).resolves.toMatchObject({
        before: { kind: "none" },
        after: { kind: "none" },
        changed: false,
      });
      await expect(rebind({ kind: "work", workId: ids.workId })).resolves.toMatchObject({
        before: { kind: "none" },
        after: { kind: "work", workId: ids.workId },
        changed: true,
      });
      await expect(rebind({ kind: "none" })).resolves.toMatchObject({
        before: { kind: "work", workId: ids.workId },
        after: { kind: "none" },
        changed: true,
      });
      await expect(repos.threadWorks.findPrimary(ids.threadId)).resolves.toBeNull();
      await expect(repos.threadWorks.listByThread(ids.threadId)).resolves.toContainEqual({
        workId: ids.workId,
        isPrimary: false,
      });
    });

    it("serializes concurrent Work targets to one primary", async () => {
      await repos.threadWorks.addMembership(ids.threadId, ids.workId, true);
      await Promise.all([
        rebind({ kind: "none" }),
        rebind({ kind: "work", workId: ids.targetWorkId }),
      ]);
      const primary = await repos.threadWorks.findPrimary(ids.threadId);
      expect(primary === null || primary.workId === ids.targetWorkId).toBe(true);
      expect(
        (await repos.threadWorks.listByThread(ids.threadId)).filter((row) => row.isPrimary),
      ).toHaveLength(primary ? 1 : 0);
    });
  });
