/** Joins admission settlement to the existing runner's serialized turn-start transaction. */
import { TurnStartConflictError } from "../../threads/index.js";
import { StaleConnectionTokenError, type TurnRunner } from "../loop/turn-runner.js";
import type { AdmissionPersistencePort } from "./drizzle-admission-records.js";
import {
  AdmissionConflictError,
  type AdmissionRecord,
  type AdmissionTurnStarter,
} from "./user-turn-admission.js";

class AdmissionWinnerError extends Error {
  constructor(readonly winner: AdmissionRecord) {
    super("admission_winner");
  }
}

export function createAdmissionTurnStarter(deps: {
  runner: TurnRunner;
  records: AdmissionPersistencePort;
  consumeUploads(documentIds: readonly string[]): Promise<void>;
  attachDocument(
    threadId: string,
    documentId: string,
    relationship: "reading" | "created",
  ): Promise<unknown>;
}): AdmissionTurnStarter {
  return {
    async start(input) {
      try {
        const started = await deps.runner.startTurn({
          threadId: input.admission.threadId,
          userText: input.admission.text,
          userBlocks: input.blocks,
          connectionToken: input.admission.connectionToken,
          admissionIdentity: {
            submissionId: input.admission.submissionId,
            async onAccepted(response) {
              const accepted = await deps.records.accept({
                response,
                actorUserId: input.admission.actorUserId,
                fingerprint: input.fingerprint,
              });
              if (accepted.kind === "winner") throw new AdmissionWinnerError(accepted.record);
              await deps.consumeUploads(
                input.references
                  .filter((reference) => reference.purpose === "draft-upload")
                  .map((reference) => reference.documentId),
              );
              for (const reference of input.references) {
                await deps.attachDocument(
                  input.admission.threadId,
                  reference.documentId,
                  reference.relationship,
                );
              }
            },
          },
        });
        return {
          kind: "accepted",
          threadId: input.admission.threadId,
          submissionId: input.admission.submissionId,
          ...started,
        };
      } catch (error) {
        if (error instanceof AdmissionWinnerError) {
          const winner = error.winner;
          if (winner.state === "accepted") {
            if (winner.fingerprint !== input.fingerprint) throw new AdmissionConflictError();
            return { ...winner.response, kind: "already-accepted" };
          }
          if (winner.state === "pending") {
            return { kind: "pending", submissionId: input.admission.submissionId };
          }
          return {
            kind: "rejected",
            submissionId: input.admission.submissionId,
            code: winner.state === "retired" ? "retired" : winner.code,
          };
        }
        if (error instanceof StaleConnectionTokenError) {
          return {
            kind: "rejected",
            submissionId: input.admission.submissionId,
            code: "connection_token_not_live",
          };
        }
        if (error instanceof TurnStartConflictError) {
          return {
            kind: "rejected",
            submissionId: input.admission.submissionId,
            code: "already_running",
          };
        }
        throw error;
      }
    },
  };
}
