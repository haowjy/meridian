/** Structural session-registry surface and the temporary pre-F1-I caller bridge. */
import type {
  LiveDocumentSessionAuthority,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";

import type { DocumentSession, DocumentSessionSnapshot } from "./document-session";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

export interface LiveDocumentSessionRegistry extends LiveDocumentSessionAuthority {
  get(lease: LiveDocumentSessionLease): DocumentSession;
  getDetached(lease: LiveDocumentSessionLease): DocumentSession;
  attachDetached(lease: LiveDocumentSessionLease): DocumentSession;
  restartUnavailableRoom(lease: LiveDocumentSessionLease): Promise<boolean>;
  retain(
    ownerId: string,
    leases: Iterable<LiveDocumentSessionLease>,
    options?: { detachedDocumentIds?: Iterable<DocumentId> },
  ): void;
  release(ownerId: string): void;
  peekLive(lease: LiveDocumentSessionLease): DocumentSession | undefined;
  hasLive(lease: LiveDocumentSessionLease): boolean;
  observeLive(
    lease: LiveDocumentSessionLease,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void;
  getBranchRoom(roomKey: string): DocumentSession;
  retainBranchRooms(ownerId: string, roomKeys: Iterable<string>): void;
  releaseBranchRooms(ownerId: string): void;
  setOwnUserId(userId: UserId): void;
  destroyAll(): void;
}

export type TemporaryUnfencedDocumentSessionRegistry = {
  get: (documentId: string) => DocumentSession;
  getRoom: (roomKey: string) => DocumentSession;
  getDetached: (documentId: string) => DocumentSession;
  attachDetached: (documentId: string) => DocumentSession;
  restartUnavailableRoom: (documentId: string) => Promise<boolean>;
  retain: (
    ownerId: string,
    roomKeys: Iterable<string>,
    options?: { detachedRoomKeys?: Iterable<string> },
  ) => void;
  release: (ownerId: string) => void;
  peek: (roomKey: string) => DocumentSession | undefined;
  has: (roomKey: string) => boolean;
  observe: (roomKey: string, observer: (snapshot: DocumentSessionSnapshot) => void) => () => void;
  revokeRoom: (roomKey: string, options?: { clearPersistence?: boolean }) => Promise<void>;
  destroyRoom: (roomKey: string, options?: { clearPersistence?: boolean }) => Promise<void>;
  destroyAll: () => void;
  setOwnUserId: (userId: UserId) => void;
};

let sharedRegistry: DocumentSessionRegistry | null = null;
let temporaryFacade: TemporaryUnfencedDocumentSessionRegistry | null = null;

export function getLiveDocumentSessionRegistry(): LiveDocumentSessionRegistry {
  sharedRegistry ??= new DocumentSessionRegistry();
  return sharedRegistry;
}

/** F1-I deletion target: private bridge for callers awaiting availability/admission wiring. */
export function getDocumentSessionRegistry(): TemporaryUnfencedDocumentSessionRegistry {
  if (temporaryFacade) return temporaryFacade;
  sharedRegistry ??= new DocumentSessionRegistry();
  const registry = sharedRegistry;
  temporaryFacade = {
    get: (id) => registry.temporaryGet(id),
    getRoom: (id) => registry.temporaryGet(id),
    getDetached: (id) => registry.temporaryGetDetached(id),
    attachDetached: (id) => registry.temporaryAttachDetached(id),
    restartUnavailableRoom: (id) => registry.temporaryRestartUnavailableRoom(id),
    retain: (owner, ids, options) => registry.temporaryRetain(owner, ids, options),
    release: (owner) => registry.temporaryRelease(owner),
    peek: (id) => registry.temporaryPeek(id),
    has: (id) => registry.temporaryPeek(id) !== undefined,
    observe: (id, observer) => registry.temporaryObserve(id, observer),
    revokeRoom: (id) => registry.temporaryRevokeRoom(id),
    destroyRoom: (id) => registry.temporaryRevokeRoom(id),
    destroyAll: () => registry.destroyAll(),
    setOwnUserId: (id) => registry.setOwnUserId(id),
  };
  return temporaryFacade;
}

export function configureDocumentSessionUser(userId: UserId): void {
  getLiveDocumentSessionRegistry().setOwnUserId(userId);
}
