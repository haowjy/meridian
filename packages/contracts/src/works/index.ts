export type AiWriteMode = "direct" | "draft";
export type WorkStatus = "active" | "archived";

export const AI_WRITE_MODE_VALUES: readonly AiWriteMode[] = ["direct", "draft"];

import type { ProjectId, ThreadId, UserId, WorkId } from "../ids.js";
import type { WorkBindingReceiptState } from "./receipts.js";

export interface Work {
  id: WorkId;
  projectId: ProjectId;
  createdByUserId: UserId;
  name: string;
  /** Stable project-unique handle. Renaming a Work does not change it. */
  slug: string;
  goal: string | null;
  description: string | null;
  status: WorkStatus;
  archivedAt: string | null;
  aiWriteMode: AiWriteMode;
  /**
   * the server's count of unpushed `branch_write_journal` rows across
   * this work's branches (spec §3.4) — the single denominator the whole review
   * surface trusts. The confirm-and-push popover renders this exact N ("Apply N
   * and switch") and the server pushes exactly this many, so the copy cannot
   * lie. MUST come from the server, never recomputed from visible dock rows.
   * Produced by the S4 server lane; `null`/absent until it lands.
   */
  unpushedChangeCount?: number | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  deletedAt: string | null;
}

export interface CreateWorkRequest {
  id?: WorkId;
  name: string;
  goal?: string;
  description?: string;
}

export interface UpdateWorkRequest {
  name?: string;
  goal?: string;
  description?: string;
}

export type ThreadWorkScope = { kind: "none" } | { kind: "work"; workId: WorkId; workSlug: string };

export type ThreadExecutionContext =
  | { scope: { kind: "none" }; aiWriteMode: "direct"; draftOwner: null }
  | {
      scope: Extract<ThreadWorkScope, { kind: "work" }>;
      aiWriteMode: AiWriteMode;
      draftOwner: { kind: "work"; workId: WorkId } | null;
    };

/** Canonical domain command shared by writer and agent adapters. */
export interface RebindThreadWorkRequest {
  target: { kind: "none" } | { kind: "work"; workId: WorkId };
}

export type RebindThreadWorkError =
  | { code: "thread_unavailable" }
  | { code: "target_work_unavailable"; workId: WorkId }
  | { code: "project_mismatch"; workId: WorkId };

export type WorkRequiredError = { code: "work_required"; operation: string };

export type WorkContextUpdateStatus = "delivered" | "pending" | "not_required";

/** Authoritative result shared by writer and model Work-rebind adapters. */
export interface RebindThreadWorkResult {
  threadId: ThreadId;
  before: WorkBindingReceiptState;
  after: WorkBindingReceiptState;
  changed: boolean;
  receipt: {
    operation: "switch";
    category: "binding";
    before: WorkBindingReceiptState;
    after: WorkBindingReceiptState;
    inverse: null;
  };
}

export interface RebindThreadWorkResponse extends RebindThreadWorkResult {
  contextUpdate: WorkContextUpdateStatus;
}

/** Live AG-UI projection emitted after a durable Work-context update commits. */
export const WORK_CONTEXT_PROJECTION_EVENT = "meridian.work_context.changed" as const;

export interface WorkContextProjectionSignal {
  threadId: import("../ids.js").ThreadId;
  projectId: ProjectId;
  scope: ThreadWorkScope;
}

export * from "./receipts.js";
