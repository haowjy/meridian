/** Atomic side-effect ordering at the runner/admission transaction join. */
import { describe, expect, it, vi } from "vitest";
import { StaleConnectionTokenError } from "../loop/turn-runner.js";
import { createAdmissionTurnStarter } from "./admission-turn-starter.js";

const admission = {
  actorUserId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  submissionId: "submission",
  text: "text",
  blocks: [],
  references: [],
} as never;
const admissionThreadId = "22222222-2222-4222-8222-222222222222" as never;
const admissionSubmissionId = "submission";

function startInput() {
  return {
    admission,
    fingerprint: "fingerprint",
    blocks: [{ type: "text" as const, text: "text" }],
    references: [
      {
        documentId: "33333333-3333-4333-8333-333333333333" as never,
        uri: "uploads://@/draft.png",
        purpose: "draft-upload" as const,
        intakeId: "intake",
        relationship: "created" as const,
      },
    ],
  };
}

describe("createAdmissionTurnStarter", () => {
  it("settles ledger, upload consumption, and provenance inside the runner callback", async () => {
    const order: string[] = [];
    const runner = {
      async startTurn(input: {
        admissionIdentity: { onAccepted(response: unknown): Promise<void> };
      }) {
        order.push("transaction-start");
        await input.admissionIdentity.onAccepted({
          kind: "accepted",
          threadId: admissionThreadId,
          submissionId: admissionSubmissionId,
          userTurnId: "user",
          assistantTurnId: "assistant",
          resumeAfterSeq: "1",
          snapshotFloorNextSeq: "5",
        });
        order.push("transaction-commit");
        return {
          userTurnId: "user",
          assistantTurnId: "assistant",
          resumeAfterSeq: "1",
          snapshotFloorNextSeq: "5",
        };
      },
    } as never;
    const starter = createAdmissionTurnStarter({
      runner,
      records: {
        lookup: vi.fn(),
        retire: vi.fn(),
        recoverExpiredPending: vi.fn(),
        async accept() {
          order.push("ledger");
          return { kind: "accepted", response: {} as never };
        },
      },
      async consumeUploads() {
        order.push("consume");
      },
      async attachDocument() {
        order.push("provenance");
      },
    });
    await expect(starter.start(startInput())).resolves.toMatchObject({ kind: "accepted" });
    expect(order).toEqual([
      "transaction-start",
      "ledger",
      "consume",
      "provenance",
      "transaction-commit",
    ]);
  });

  it("cannot consume an upload when token or claim admission fails", async () => {
    const consumeUploads = vi.fn();
    const starter = createAdmissionTurnStarter({
      runner: {
        async startTurn() {
          throw new StaleConnectionTokenError();
        },
      } as never,
      records: {
        lookup: vi.fn(),
        retire: vi.fn(),
        accept: vi.fn(),
        recoverExpiredPending: vi.fn(),
      },
      consumeUploads,
      attachDocument: vi.fn(),
    });
    await expect(starter.start(startInput())).resolves.toEqual({
      kind: "rejected",
      submissionId: "submission",
      code: "connection_token_not_live",
    });
    expect(consumeUploads).not.toHaveBeenCalled();
  });
});
