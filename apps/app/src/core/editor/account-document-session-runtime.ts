/** Immutable account epoch and two-phase lifecycle for document-session owners. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionReservationPort,
} from "./local-document-session-adoption";

export interface AccountDocumentSessionRuntime {
  readonly accountId: AccountId;
  readonly epochSignal: AbortSignal;
  readonly registry: LiveDocumentSessionRegistry;
  readonly localReservation: LocalDocumentSessionReservationPort;
  readonly localAdoption: LocalDocumentSessionAdoptionPort;
  beginClose(): void;
  finishClose(): Promise<void>;
}

type RuntimeInput = {
  accountId: AccountId;
  registry?: LiveDocumentSessionRegistry;
  localReservation?: LocalDocumentSessionReservationPort;
  localAdoption?: LocalDocumentSessionAdoptionPort;
  closeLocalSessions(): Promise<void>;
  closeRegistry?(): Promise<void>;
};

export function createAccountDocumentSessionRuntime(
  input: RuntimeInput,
): AccountDocumentSessionRuntime {
  const ownedRegistry = input.registry
    ? null
    : new DocumentSessionRegistry(undefined, undefined, input.accountId);
  const coreRegistry = input.registry ?? ownedRegistry;
  if (!coreRegistry) throw new Error("Account registry construction failed");
  const closeRegistry =
    input.closeRegistry ??
    (() => {
      if (!ownedRegistry) throw new Error("Injected account registry requires a close operation");
      return ownedRegistry.closeAccountRuntime();
    });
  const reservation =
    input.localReservation ??
    ({
      reserve: () => {
        throw new Error("Local document reservation is not installed until F1-I1");
      },
    } satisfies LocalDocumentSessionReservationPort);
  const adoptionFacet =
    input.localAdoption ??
    ({
      admitAndAdopt: async () => {
        throw new Error("Local document adoption is not installed until F1-I1");
      },
    } satisfies LocalDocumentSessionAdoptionPort);
  const epoch = new AbortController();
  let state: "open" | "closing" | "closed" = "open";
  let finishPromise: Promise<void> | null = null;
  const requireOpen = () => {
    if (state !== "open") throw new Error(`Account document session runtime is ${state}`);
  };

  const registry = new Proxy(coreRegistry, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (
        property === "release" ||
        property === "releaseBranchRooms" ||
        property === "revokeDocument" ||
        property === "revokeAccess"
      ) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        requireOpen();
        const result = Reflect.apply(value, target, args);
        if (result instanceof Promise) {
          return result.then((settled) => {
            requireOpen();
            return settled;
          });
        }
        return result;
      };
    },
  });
  const localReservation: LocalDocumentSessionReservationPort = {
    reserve(transfer) {
      requireOpen();
      return reservation.reserve(transfer);
    },
  };
  const localAdoption: LocalDocumentSessionAdoptionPort = {
    admitAndAdopt(request) {
      try {
        requireOpen();
      } catch (error) {
        return Promise.reject(error);
      }
      return adoptionFacet.admitAndAdopt(request).then((settled) => {
        requireOpen();
        return settled;
      });
    },
  };

  const beginClose = () => {
    if (state !== "open") return;
    state = "closing";
    epoch.abort(new Error("Account document session runtime is closing"));
  };
  return Object.freeze({
    accountId: input.accountId,
    epochSignal: epoch.signal,
    registry,
    localReservation,
    localAdoption,
    beginClose,
    finishClose() {
      if (finishPromise) return finishPromise;
      beginClose();
      finishPromise = (async () => {
        const errors: unknown[] = [];
        try {
          await input.closeLocalSessions();
        } catch (error) {
          errors.push(error);
        }
        try {
          await closeRegistry();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Account document session teardown failed");
        }
        state = "closed";
      })();
      return finishPromise;
    },
  });
}
