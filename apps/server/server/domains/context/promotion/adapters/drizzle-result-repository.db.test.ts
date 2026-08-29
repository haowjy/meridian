/** Durable reconciliation contract for caller-owned promotion result identity. */

import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { projectResults, projects, threads, turns, users } from "@meridian/database/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../../test-support/rollback-test-database.js";
import type { CreateProjectResultInput } from "../ports/result-repository.js";
import { createDrizzleResultRepository } from "./drizzle-result-repository.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("result repository reconciliation (postgres)", () => {});
} else {
  describe("result repository reconciliation (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000a01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000a02";
    const THREAD_ID = "00000000-0000-4000-8000-000000000a03";
    const TURN_ID = "00000000-0000-4000-8000-000000000a04";
    const RESULT_ID = "00000000-0000-4000-8000-000000000a05";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });
    let db = database.current;

    const input: CreateProjectResultInput = {
      id: RESULT_ID,
      projectId: PROJECT_ID,
      sourcePath: "reports/final.txt",
      resultsUri: "results://@/threads/root/reports/final.txt",
      storageUrl: "memory://result",
      mimeType: "text/plain",
      sizeBytes: 5,
      provenance: {
        rootThreadId: THREAD_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        toolCallId: "call-1",
        agentSlug: "writer",
      },
    };

    beforeEach(async () => {
      db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "result-reconciliation"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Result reconciliation",
        slug: "result-reconciliation",
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
      });
      await db.insert(turns).values({ id: TURN_ID, threadId: THREAD_ID, role: "assistant" });
    });

    it("serializes concurrent unresolved callers on the same result identity", async () => {
      const repository = createDrizzleResultRepository(db);
      const outcomes = await Promise.all([
        repository.createOrConverge(input),
        repository.createOrConverge(input),
      ]);

      expect(outcomes.map((outcome) => outcome.kind)).toEqual(["committed", "committed"]);
      await expect(db.select().from(projectResults)).resolves.toHaveLength(1);
    });

    it("converges an exact prior commit but never adopts a mismatched payload", async () => {
      const repository = createDrizzleResultRepository(db);
      await expect(repository.createOrConverge(input)).resolves.toMatchObject({
        kind: "committed",
      });
      await expect(repository.createOrConverge(input)).resolves.toMatchObject({
        kind: "committed",
      });
      await expect(
        repository.createOrConverge({ ...input, storageUrl: "memory://different" }),
      ).resolves.toEqual({
        kind: "unknown",
        error: "Result ID already has different payload",
      });
      await expect(db.select().from(projectResults)).resolves.toHaveLength(1);
    });
  });
}
