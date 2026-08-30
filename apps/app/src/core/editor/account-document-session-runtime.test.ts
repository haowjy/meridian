import type { AccountId, LiveDocumentSessionLease } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type AccountDocumentSessionCore,
  createAccountDocumentSessionRuntime,
} from "./account-document-session-runtime";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AccountDocumentSessionRuntime", () => {
  it("uses one cohesive core, fences synchronously, and leaves feature teardown to its provider", async () => {
    const pendingAdmission = deferred();
    const coreClosed = deferred();
    let closing = false;
    let committed = false;
    const release = vi.fn();
    const registry = {
      admit: vi.fn(async () => {
        await pendingAdmission.promise;
        if (closing) throw new Error("core is closing");
        committed = true;
        return {} as LiveDocumentSessionLease;
      }),
      release,
    } as unknown as LiveDocumentSessionRegistry;
    const core = {
      accountId: "account-a" as AccountId,
      registry,
      localReservation: {
        reserve: () => {
          if (closing) throw new Error("core is closing");
          throw new Error("not installed");
        },
      },
      localAdoption: {
        admitAndAdopt: async () => {
          if (closing) throw new Error("core is closing");
          throw new Error("not installed");
        },
      },
      localConstruction: {
        createDetached: () => {
          if (closing) throw new Error("core is closing");
          throw new Error("not installed");
        },
      },
      beginClose: vi.fn(() => {
        closing = true;
      }),
      finishClose: vi.fn(async () => coreClosed.promise),
    } satisfies AccountDocumentSessionCore;
    const runtime = createAccountDocumentSessionRuntime({ accountId: core.accountId, core });

    const opening = runtime.registry.admit("project", "document", "1");
    runtime.beginClose();
    expect(core.beginClose).toHaveBeenCalledOnce();
    expect(runtime.epochSignal.aborted).toBe(true);
    expect(() => runtime.registry.admit("project", "document", "1")).toThrow(/closing/);
    expect(() => runtime.localReservation.reserve({} as never)).toThrow(/closing/);
    await expect(runtime.localAdoption.admitAndAdopt({} as never)).rejects.toThrow(/closing/);
    expect(() => runtime.localConstruction.createDetached({} as never)).toThrow(/closing/);
    runtime.registry.release("owner");
    expect(release).toHaveBeenCalledWith("owner");

    pendingAdmission.resolve();
    await expect(opening).rejects.toThrow(/core is closing/);
    expect(committed).toBe(false);

    const closingRuntime = runtime.finishClose();
    expect(core.finishClose).toHaveBeenCalledOnce();
    let exposed = false;
    const exposeB = closingRuntime.then(() => {
      exposed = true;
    });
    await Promise.resolve();
    expect(exposed).toBe(false);
    coreClosed.resolve();
    await exposeB;
    expect(exposed).toBe(true);
    await runtime.finishClose();
    expect(core.finishClose).toHaveBeenCalledOnce();
  });

  it("rejects a cohesive core for another immutable account", () => {
    const core = { accountId: "account-a" } as AccountDocumentSessionCore;
    expect(() =>
      createAccountDocumentSessionRuntime({
        accountId: "account-b" as AccountId,
        core,
      }),
    ).toThrow(/different account/);
  });
});
