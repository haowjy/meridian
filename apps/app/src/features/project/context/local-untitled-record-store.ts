/** Durable, per-document local Untitled ownership records; browser storage is adapted later. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

export type LocalUntitledKey = Readonly<{
  accountId: AccountId;
  projectId: ProjectId;
  documentId: DocumentId;
}>;

export type LocalUntitledRecord = Readonly<{
  key: LocalUntitledKey;
  lineageId: string;
  revision: number;
  phase: "local-pending" | "adopted-live";
  home: Readonly<{ scheme: string; path: string; name: string }> | null;
}>;

export interface LocalUntitledRecordStore {
  read(key: LocalUntitledKey): LocalUntitledRecord | null;
  write(record: LocalUntitledRecord): void;
  remove(key: LocalUntitledKey, expectedRevision: number): "removed" | "stale";
  list(accountId: AccountId): readonly LocalUntitledRecord[];
}
