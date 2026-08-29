/** Project-final stable-document availability protocol. */
import type { DocumentId, ProjectId, UserId, WorkId } from "../ids.js";
import type { WorkSlug } from "../works/work-slug.js";
import type { CatalogFileEntry } from "./context-catalog.js";

export type AvailabilityGeneration = string;

export type ProjectContextIdentityLookupRequest = {
  projectId: ProjectId;
  documentIds: readonly DocumentId[];
};

export type ProjectContextAuthority =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "none"; projectId: ProjectId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId; workSlug: WorkSlug };

export type ProjectContextIdentityResolution =
  | {
      kind: "available";
      documentId: DocumentId;
      generation: AvailabilityGeneration;
      authority: ProjectContextAuthority;
      entry: CatalogFileEntry;
    }
  | {
      kind: "deleted";
      documentId: DocumentId;
      generation: AvailabilityGeneration;
      lastAuthority: ProjectContextAuthority;
    }
  | {
      kind: "authority-unavailable";
      documentId: DocumentId;
      generation: AvailabilityGeneration;
      authority: ProjectContextAuthority;
      reason: "work_archived" | "work_deleted" | "project_deleted";
    }
  | {
      kind: "not-visible";
      documentId: DocumentId;
      checkedGeneration: AvailabilityGeneration;
    }
  | {
      kind: "indeterminate";
      documentId: DocumentId;
      checkedGeneration: AvailabilityGeneration;
      reason: "identity_inconsistent";
    };

export type ProjectContextIdentityLookupResult = {
  projectId: ProjectId;
  resolutionId: string;
  resolutions: readonly ProjectContextIdentityResolution[];
};

export const PROJECT_CONTEXT_AVAILABILITY_MAX_IDS = 128;
