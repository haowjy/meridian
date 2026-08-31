/** PostgreSQL proof that admission and explicit retirement choose one serialized winner. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const RUN = process.env.RUN_DB_TESTS === "1" && process.env.DATABASE_URL;
if (!RUN) {
  describe.skip("user turn admission ledger (postgres)", () => {});
} else {
  describe("user turn admission ledger (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { createDrizzleAdmissionRecords } = await import("./drizzle-admission-records.js");
    const { createAdmissionTurnStarter } = await import("./admission-turn-starter.js");
    const { createUserTurnAdmission } = await import("./user-turn-admission.js");
    const { createTurnRunner } = await import("../loop/turn-runner.js");
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL disappeared after the DB test gate");
    const firstDb = createDb(url, { max: 2 });
    const secondDb = createDb(url, { max: 2 });
    const repos = createDrizzleRepositoriesForTest(firstDb);
    const records = createDrizzleAdmissionRecords(firstDb);
    const retireRecords = createDrizzleAdmissionRecords(secondDb);
    const USER = "00000000-0000-4000-8000-000000000f51";
    const PROJECT = "00000000-0000-4000-8000-000000000f52";
    const THREAD = "00000000-0000-4000-8000-000000000f53" as never;

    beforeEach(async () => {
      await truncateDrizzleTables(firstDb, [schema.users]);
      await firstDb.insert(schema.users).values(conformanceUserValues(USER, "admission"));
      await firstDb
        .insert(schema.projects)
        .values({ id: PROJECT, userId: USER, name: "Admission", slug: "admission" });
      await firstDb.insert(schema.threads).values({
        id: THREAD,
        projectId: PROJECT,
        createdByUserId: USER,
        title: "",
        kind: "primary",
        status: "idle",
      });
    });
    afterAll(async () => {
      await firstDb.close();
      await secondDb.close();
    });

    it("persists and replays a production-composed stale-token rejection", async () => {
      let orchestratorStarts = 0;
      const consumeUploads = vi.fn();
      const runner = createTurnRunner({
        orchestrator: {
          async runTurn() {
            orchestratorStarts += 1;
            throw new Error("a terminal identity re-entered turn effects");
          },
        } as never,
        hub: {} as never,
        repos: { turns: {} as never },
        eventSink: {} as never,
        workContextDelivery: {} as never,
      });
      const service = createUserTurnAdmission({
        records,
        availability: {
          async lookup() {
            return { projectId: PROJECT, resolutionId: "resolution", resolutions: [] };
          },
        } as never,
        async threadProject() {
          return PROJECT;
        },
        starter: createAdmissionTurnStarter({
          runner,
          records,
          consumeUploads,
          attachDocument: vi.fn(),
        }),
      });
      const admission = {
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "stale-token-rejection",
        connectionToken: "not-registered",
        text: "writer text",
        blocks: [{ type: "text" as const, text: "writer text" }],
        references: [],
      };

      await expect(service.admit(admission)).resolves.toEqual({
        kind: "rejected",
        submissionId: admission.submissionId,
        code: "connection_token_not_live",
      });
      await expect(
        service.lookup({
          actorUserId: USER as never,
          threadId: THREAD,
          submissionId: admission.submissionId,
        }),
      ).resolves.toEqual({
        kind: "rejected",
        submissionId: admission.submissionId,
        code: "connection_token_not_live",
      });
      await expect(firstDb.select().from(schema.userTurnAdmissions)).resolves.toMatchObject([
        {
          threadId: THREAD,
          submissionId: admission.submissionId,
          actorUserId: USER,
          state: "rejected",
          rejectionCode: "connection_token_not_live",
        },
      ]);

      runner.registerLiveConnectionToken(admission.connectionToken);
      await expect(service.admit(admission)).resolves.toEqual({
        kind: "rejected",
        submissionId: admission.submissionId,
        code: "connection_token_not_live",
      });
      await expect(
        service.admit({
          ...admission,
          text: "different",
          blocks: [{ type: "text", text: "different" }],
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(orchestratorStarts).toBe(0);
      expect(consumeUploads).not.toHaveBeenCalled();
      await expect(firstDb.select().from(schema.turns)).resolves.toHaveLength(0);
    });

    it("lets exactly one same-identity contender reserve the pending row", async () => {
      const request = {
        threadId: THREAD,
        submissionId: "contended",
        actorUserId: USER,
        fingerprint: "same-fingerprint",
        claimExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
      };
      const results = await Promise.all([records.reserve(request), retireRecords.reserve(request)]);
      expect(results).toEqual(
        expect.arrayContaining([
          { kind: "reserved" },
          { kind: "winner", record: { state: "pending", fingerprint: "same-fingerprint" } },
        ]),
      );
      await expect(firstDb.select().from(schema.userTurnAdmissions)).resolves.toHaveLength(1);
    });

    it("returns the accepted winner when admission holds the turn-start lock first", async () => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const response = {
        kind: "accepted" as const,
        threadId: THREAD,
        submissionId: "submission",
        userTurnId: "00000000-0000-4000-8000-000000000f54" as never,
        assistantTurnId: "00000000-0000-4000-8000-000000000f55" as never,
        resumeAfterSeq: "0",
        snapshotFloorNextSeq: "4",
      };
      await records.reserve({
        threadId: THREAD,
        submissionId: response.submissionId,
        actorUserId: USER,
        fingerprint: "fingerprint",
        claimExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
      });
      const admission = repos.runTurnStartTransition(THREAD, null, async () => {
        locked();
        await barrier;
        return records.accept({ response, fingerprint: "fingerprint" });
      });
      await acquired;
      const retirement = retireRecords.retire({
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "submission",
      });
      release();
      await expect(admission).resolves.toMatchObject({ kind: "accepted" });
      await expect(retirement).resolves.toMatchObject({
        kind: "already-accepted",
        userTurnId: response.userTurnId,
      });
    });

    it("retirement of an unseen identity prevents delayed acceptance", async () => {
      await expect(
        retireRecords.retire({
          actorUserId: USER as never,
          threadId: THREAD,
          submissionId: "late",
        }),
      ).resolves.toMatchObject({ kind: "retired" });
      await repos.runTurnStartTransition(THREAD, null, async () => {
        const winner = await records.accept({
          response: {
            kind: "accepted",
            threadId: THREAD,
            submissionId: "late",
            userTurnId: "00000000-0000-4000-8000-000000000f56" as never,
            assistantTurnId: "00000000-0000-4000-8000-000000000f57" as never,
            resumeAfterSeq: "0",
            snapshotFloorNextSeq: "4",
          },
          fingerprint: "fingerprint",
        });
        expect(winner).toMatchObject({ kind: "winner", record: { state: "retired" } });
      });
    });

    it("does not turn claim expiry into rejection until recovery proves no live claim or committed turn", async () => {
      await firstDb.insert(schema.userTurnAdmissions).values({
        threadId: THREAD,
        submissionId: "pending",
        actorUserId: USER,
        fingerprint: "fingerprint",
        state: "pending",
        claimExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await expect(records.lookup(THREAD, "pending")).resolves.toMatchObject({ state: "pending" });
      await expect(
        records.recoverExpiredPending({
          threadId: THREAD,
          submissionId: "pending",
          now: new Date("2026-01-02T00:00:00.000Z"),
          async hasLiveClaim() {
            return true;
          },
        }),
      ).resolves.toMatchObject({ state: "pending" });
      await expect(
        records.recoverExpiredPending({
          threadId: THREAD,
          submissionId: "pending",
          now: new Date("2026-01-02T00:00:00.000Z"),
          async hasLiveClaim() {
            return false;
          },
        }),
      ).resolves.toMatchObject({ state: "rejected", code: "recovery_no_committed_turn" });
    });
  });
}
