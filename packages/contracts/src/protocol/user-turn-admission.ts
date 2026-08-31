/** Durable writer-turn admission wire contracts. */
import type { DocumentId, UserId } from "../ids.js";
import type { ThreadId, TurnId } from "../runtime/index.js";

export type UserMessageBlock =
  | { type: "text"; text: string }
  | { type: "image"; documentId: DocumentId; uri: string };

export type SubmittedReference = {
  documentId: DocumentId;
  uri: string;
  purpose: "reference" | "draft-upload";
  intakeId?: string;
};

export type AdmissionFingerprint = string;

export type UserTurnAdmissionInput = {
  actorUserId: UserId;
  threadId: ThreadId;
  submissionId: string;
  connectionToken?: string;
  text: string;
  blocks: unknown;
  references: readonly SubmittedReference[];
};

export type AcceptedAdmission = {
  kind: "accepted" | "already-accepted";
  threadId: ThreadId;
  submissionId: string;
  userTurnId: TurnId;
  assistantTurnId: TurnId;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
};

export type AdmissionLookup =
  | AcceptedAdmission
  | { kind: "pending"; submissionId: string }
  | { kind: "rejected" | "retired"; submissionId: string; code: string }
  | { kind: "not-seen"; submissionId: string };

export type AdmissionLookupRequest = Pick<
  UserTurnAdmissionInput,
  "actorUserId" | "threadId" | "submissionId"
>;
export type RetireAdmissionRequest = AdmissionLookupRequest;
export type RetireAdmissionResult =
  | { kind: "retired"; submissionId: string; code: "retired" }
  | AcceptedAdmission
  | { kind: "pending"; submissionId: string }
  | { kind: "rejected"; submissionId: string; code: string };

export type AdmissionErrorCode =
  | "idempotency_conflict"
  | "connection_token_not_live"
  | "already_running"
  | "invalid_message"
  | "reference_unavailable";

export type UserTurnAdmissionResult =
  | AcceptedAdmission
  | { kind: "pending"; submissionId: string }
  | { kind: "rejected"; submissionId: string; code: AdmissionErrorCode };
