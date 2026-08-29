/** Shared transport, lock, and registry machinery for registry behavior tests. */
import "fake-indexeddb/auto";

import type { LiveDocumentSessionLease } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { DocumentSessionConnectionState } from "./document-session";

export const providers: Array<{
  emit: (state: DocumentSessionConnectionState) => void;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@/core/transport/hocuspocus-document-transport", () => ({
  createHocuspocusDocumentTransport: () => {
    const listeners = new Set<(state: DocumentSessionConnectionState) => void>();
    const provider = {
      emit: (state: DocumentSessionConnectionState) => {
        for (const listener of listeners) listener(state);
      },
      destroy: vi.fn(),
    };
    providers.push(provider);
    return {
      synced: false,
      subscribeStatus: (listener: (state: DocumentSessionConnectionState) => void) => {
        listeners.add(listener);
        listener({ kind: "connecting", attempt: 1 });
        return () => listeners.delete(listener);
      },
      destroy: provider.destroy,
    };
  },
}));

export const { DocumentSessionAuthorityError, DocumentSessionRegistry } = await import(
  "./document-session-registry-implementation"
);
export const { createDocumentSessionCrossContextCoordination } = await import(
  "./document-session-cross-context-coordination"
);

export type Registry = InstanceType<typeof DocumentSessionRegistry>;

export async function registryFor(accountId: string): Promise<Registry> {
  const registry = new DocumentSessionRegistry(undefined, 0);
  registry.setOwnUserId(accountId);
  return registry;
}

export async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).flatMap(({ name }) => (name ? [name] : []));
}

export async function openBlocker(name: string): Promise<IDBDatabase> {
  const request = indexedDB.open(name);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function expectAuthorityError(
  kind: InstanceType<typeof DocumentSessionAuthorityError>["kind"],
) {
  return expect.objectContaining({ name: "DocumentSessionAuthorityError", kind });
}

export async function admit(
  registry: Registry,
  projectId: string,
  documentId: string,
  generation: string,
): Promise<LiveDocumentSessionLease> {
  return registry.admit(projectId, documentId, generation);
}

export class TestLocks {
  readonly active = new Map<string, { shared: number; exclusive: boolean }>();
  private queues = new Map<string, Array<() => void>>();
  request<T>(
    name: string,
    options: { mode?: "shared" | "exclusive"; ifAvailable?: boolean },
    callback: (lock: object | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const mode = options.mode ?? "exclusive";
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const state = this.active.get(name) ?? { shared: 0, exclusive: false };
        const available =
          mode === "shared" ? !state.exclusive : !state.exclusive && state.shared === 0;
        if (!available) {
          if (options.ifAvailable) void Promise.resolve(callback(null)).then(resolve, reject);
          else {
            const queue = this.queues.get(name) ?? [];
            queue.push(attempt);
            this.queues.set(name, queue);
          }
          return;
        }
        if (mode === "shared") state.shared += 1;
        else state.exclusive = true;
        this.active.set(name, state);
        void Promise.resolve(callback({ name }))
          .then(resolve, reject)
          .finally(() => {
            const current = this.active.get(name);
            if (current) {
              if (mode === "shared") current.shared -= 1;
              else current.exclusive = false;
              if (!current.shared && !current.exclusive) this.active.delete(name);
            }
            const queue = this.queues.get(name);
            const next = queue?.shift();
            if (!queue?.length) this.queues.delete(name);
            next?.();
          });
      };
      attempt();
    });
  }

  activeFor(accountId: string): string[] {
    return [...this.active.keys()].filter((name) => name.includes(accountId));
  }
}

beforeEach(() => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { ...navigator, locks: new TestLocks() });
});
afterEach(() => {
  providers.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
