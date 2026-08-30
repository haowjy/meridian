/** Private facets for transferring one local Untitled session into admitted live ownership. */
import type {
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { DocumentSession } from "./document-session";

declare const handoffBrand: unique symbol;

export type LocalDocumentSessionTransfer = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
  session: DocumentSession;
  ownerRevision: number;
  /** Throws before the durable ownership transition if the owner record moved. */
  prepareCommit(): void;
  /** Nonthrowing synchronous convergence after the durable phase write. */
  commit(): void;
}>;

export type LocalDocumentSessionHandoff = Readonly<{
  [handoffBrand]: true;
}>;

export interface LocalDocumentSessionReservationPort {
  reserve(transfer: LocalDocumentSessionTransfer): LocalDocumentSessionHandoff;
}

export interface LocalDocumentSessionAdoptionPort {
  admitAndAdopt(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    handoff: LocalDocumentSessionHandoff;
  }): Promise<{ lease: LiveDocumentSessionLease; session: DocumentSession }>;
}
