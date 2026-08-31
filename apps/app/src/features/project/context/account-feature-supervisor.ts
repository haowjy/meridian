/** Browser-root account lifetime owner and its retryable feature teardown ledger. */
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { rehydrateContextDesks } from "@/client/stores";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { AccountPostApplyDispositionOwner } from "../draft-apply-recovery/draft-apply-recovery-owner";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { BrowserLocalUntitledLineageLedger } from "./local-untitled-lineage-ledger";
import { LocalUntitledOwner } from "./local-untitled-owner";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

export class CatalogRepairDeferred extends Error {
  constructor() {
    super("Project catalog repair is deferred until account composition returns");
    this.name = "CatalogRepairDeferred";
  }
}

class ProjectCatalogRepairRelay {
  private adapter: { token: number; repair(projectId: string): Promise<void> } | null = null;
  private readonly pending = new Set<string>();
  private nextToken = 0;
  private closing = false;

  async request(projectId: string): Promise<void> {
    if (this.closing) throw new CatalogRepairDeferred();
    if (!this.adapter) {
      if (this.pending.size < 256) this.pending.add(projectId);
      throw new CatalogRepairDeferred();
    }
    await this.adapter.repair(projectId);
  }

  attach(repair: (projectId: string) => Promise<void>): { token: number; release(): void } {
    if (this.closing) throw new CatalogRepairDeferred();
    const token = ++this.nextToken;
    this.adapter = { token, repair };
    return {
      token,
      release: () => {
        if (this.adapter?.token === token) this.adapter = null;
      },
    };
  }

  async flush(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) throw new CatalogRepairDeferred();
    const failures: unknown[] = [];
    for (const projectId of [...this.pending].sort()) {
      if (this.adapter?.token !== adapter.token) throw new CatalogRepairDeferred();
      try {
        await adapter.repair(projectId);
        this.pending.delete(projectId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Project catalog repair failed");
  }

  beginClose(): void {
    this.closing = true;
    this.adapter = null;
  }

  clear(): void {
    this.pending.clear();
  }
}

export type AccountFeatureCompositionAttachment = Readonly<{
  token: number;
  release(): void;
}>;

export class AccountFeatureLifetime {
  readonly runtime;
  readonly registry;
  readonly postApplyOwner;
  readonly removal;
  readonly availability;
  readonly localOwner;
  readonly opener;
  private readonly featureLease;
  private readonly repairRelay = new ProjectCatalogRepairRelay();
  private readonly attachments = new Map<number, () => void>();
  private attachmentWaiter: (() => void) | null = null;
  private closeAttempt: Promise<void> | null = null;
  private localSettled = false;
  private featureOwnersSettled = false;
  state: "open" | "closing" | "closed" = "open";

  constructor(readonly accountId: string) {
    this.runtime = createAccountDocumentSessionRuntime({ accountId });
    this.registry = this.runtime.registry;
    this.postApplyOwner = new AccountPostApplyDispositionOwner(accountId, {
      replaceExactRoomNames: (roomNames) => {
        if (roomNames.length === 0) this.registry.releaseBranchRooms?.("post-apply-disposition");
        else this.registry.retainBranchRooms?.("post-apply-disposition", roomNames);
      },
    });
    this.removal = new ContextRemovalCoordinator(accountId, {
      sessions: this.registry,
      draftTabFence: {
        currentFence: (input) =>
          this.postApplyOwner.draftTabMutationFence({
            identity: {
              accountId: input.accountId,
              projectId: input.projectId,
              workId: input.workId,
              documentId: input.documentId,
              draftId: input.draftId,
            },
            tabInstanceToken: input.tabInstanceToken,
          }),
      },
    });
    this.availability = new ProjectContextAvailabilityCoordinator({
      lookup: lookupProjectContextAvailability,
      apply: async (commands) => {
        await this.removal.reconcileDocumentAvailability(commands).localSettlement;
      },
      repairProjectCatalog: (projectId) => this.repairRelay.request(projectId),
    });
    const storage =
      typeof window === "undefined"
        ? ({
            length: 0,
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
            clear: () => undefined,
            key: () => null,
          } as Storage)
        : window.localStorage;
    this.localOwner = new LocalUntitledOwner({
      accountId,
      ledger: new BrowserLocalUntitledLineageLedger(storage, this.runtime.localLifetime),
      identityReservations: this.runtime.localIdentityReservation,
      sessions: this.runtime.localConstruction,
      reservations: this.runtime.localReservation,
      adoption: this.runtime.localAdoption,
    });
    this.runtime.connectLocalLineageTerminal(this.localOwner.terminalPort);
    this.opener = new ProjectDocumentLiveOpener({
      availability: this.availability,
      registry: this.registry,
      adoption: this.runtime.localAdoption,
      epochSignal: this.runtime.epochSignal,
    });
    this.featureLease = this.removal.createLifetimeLease();
  }

  attachComposition(
    repairProjectCatalog: (projectId: string) => Promise<void>,
  ): AccountFeatureCompositionAttachment {
    if (this.state !== "open") throw new Error("Account feature lifetime is closing");
    const relayAttachment = this.repairRelay.attach(repairProjectCatalog);
    this.attachments.set(relayAttachment.token, relayAttachment.release);
    void this.repairRelay
      .flush()
      .then(() => this.availability.recheckWatchedProjects())
      .catch(() => undefined);
    return Object.freeze({
      token: relayAttachment.token,
      release: () => {
        const release = this.attachments.get(relayAttachment.token);
        if (!release) return;
        this.attachments.delete(relayAttachment.token);
        release();
        if (this.attachments.size === 0) this.attachmentWaiter?.();
      },
    });
  }

  resumeFeatureLease(): void {
    if (this.state === "open") this.featureLease.resume();
  }

  suspendFeatureLease(): void {
    this.featureLease.suspend();
  }

  beginClose(): void {
    if (this.state !== "open") return;
    this.state = "closing";
    this.runtime.beginClose();
    this.featureLease.suspend();
    this.repairRelay.beginClose();
  }

  finishClose(): Promise<void> {
    this.beginClose();
    if (this.state === "closed") return Promise.resolve();
    if (this.closeAttempt) return this.closeAttempt;
    const attempt = (async () => {
      if (this.attachments.size > 0) {
        await new Promise<void>((resolve) => {
          this.attachmentWaiter = resolve;
        });
        this.attachmentWaiter = null;
      }
      if (!this.featureOwnersSettled) {
        this.featureLease.disposeIfSuspended();
        this.postApplyOwner.dispose();
        this.featureOwnersSettled = true;
      }
      try {
        await this.runtime.finishClose();
      } catch (cause) {
        throw new AccountFeatureLifetimeCloseError("account-runtime", cause);
      }
      if (!this.localSettled) {
        try {
          await this.localOwner.destroyAll();
          this.localSettled = true;
        } catch (cause) {
          throw new AccountFeatureLifetimeCloseError("local-untitled", cause);
        }
      }
      this.repairRelay.clear();
      this.state = "closed";
    })();
    this.closeAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.closeAttempt === attempt) this.closeAttempt = null;
      })
      .catch(() => undefined);
    return attempt;
  }
}

class AccountFeatureLifetimeCloseError extends Error {
  constructor(
    readonly stage: "local-untitled" | "account-runtime",
    readonly cause: unknown,
  ) {
    super(`Account feature close failed during ${stage}`, { cause });
  }
}

export type AccountFeatureCloseFailure = Readonly<{
  attempt: number;
  stage: "local-untitled" | "account-runtime";
  cause: unknown;
}>;

export type AccountFeatureAuthEpoch = Readonly<{
  kind: "authenticated";
  epoch: number;
  subject: string;
}>;

export type AccountFeatureDeclaration = Readonly<{
  auth: AccountFeatureAuthEpoch;
  account: Readonly<{ id: string }>;
}>;

export type AccountFeatureSupervisorSnapshot =
  | { kind: "idle"; authEpoch: number }
  | { kind: "awaiting-composition"; authEpoch: number; desiredAccountId: string }
  | {
      kind: "ready";
      authEpoch: number;
      declaration: AccountFeatureDeclaration;
      lifetime: AccountFeatureLifetime;
    }
  | {
      kind: "closing";
      authEpoch: number;
      closingAccountId: string;
      desiredAccountId: string | null;
    }
  | {
      kind: "close-failed";
      authEpoch: number;
      closingAccountId: string;
      desiredAccountId: string | null;
      failure: AccountFeatureCloseFailure;
    }
  | { kind: "construction-failed"; authEpoch: number; desiredAccountId: string; cause: unknown }
  | { kind: "identity-inconsistent"; authEpoch: number; retainedLifetime: boolean; cause: unknown };

export class AccountFeatureSupervisor {
  private authEpoch = 0;
  private authDeclaration: AccountFeatureAuthEpoch | null = null;
  private canonical: AccountFeatureDeclaration | null = null;
  private desiredAccountId: string | null = null;
  private lifetime: AccountFeatureLifetime | null = null;
  private closeAttempt: Promise<void> | null = null;
  private preparationAttempt: Promise<void> | null = null;
  private closeFailures = 0;
  private snapshot: AccountFeatureSupervisorSnapshot = { kind: "idle", authEpoch: 0 };
  private readonly serverSnapshot: AccountFeatureSupervisorSnapshot = {
    kind: "idle",
    authEpoch: 0,
  };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly createLifetime: (accountId: string) => AccountFeatureLifetime = (accountId) =>
      new AccountFeatureLifetime(accountId),
    private readonly prepareAccount: (
      accountId: string,
    ) => Promise<void> | void = rehydrateContextDesks,
  ) {}

  getSnapshot = (): AccountFeatureSupervisorSnapshot => this.snapshot;
  getServerSnapshot = (): AccountFeatureSupervisorSnapshot => this.serverSnapshot;
  getAuthDeclaration = (): AccountFeatureAuthEpoch | null => this.authDeclaration;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setAuthIntent(intent: { loading: boolean; subject: string | null }): void {
    if (intent.loading && !intent.subject) return;
    if (intent.subject === (this.authDeclaration?.subject ?? null)) return;
    this.authEpoch += 1;
    this.authDeclaration = intent.subject
      ? Object.freeze({ kind: "authenticated", epoch: this.authEpoch, subject: intent.subject })
      : null;
    this.canonical = null;
    this.desiredAccountId = null;
    if (this.lifetime) this.startClose();
    else this.publish({ kind: "idle", authEpoch: this.authEpoch });
    if (this.snapshot.kind === "close-failed") this.startClose();
  }

  declareAccount(declaration: AccountFeatureDeclaration): void {
    if (
      !this.authDeclaration ||
      declaration.auth.epoch !== this.authEpoch ||
      declaration.auth.subject !== this.authDeclaration.subject
    ) {
      return;
    }
    if (
      this.snapshot.kind === "identity-inconsistent" ||
      this.snapshot.kind === "construction-failed"
    ) {
      return;
    }
    if (this.canonical && this.canonical.account.id !== declaration.account.id) {
      this.publish({
        kind: "identity-inconsistent",
        authEpoch: this.authEpoch,
        retainedLifetime: this.lifetime !== null,
        cause: new Error("Authenticated subject resolved to conflicting accounts"),
      });
      return;
    }
    this.canonical ??= declaration;
    this.desiredAccountId = declaration.account.id;
    if (this.lifetime) {
      if (this.lifetime.accountId === declaration.account.id && this.lifetime.state === "open") {
        this.publish({
          kind: "ready",
          authEpoch: this.authEpoch,
          declaration: this.canonical,
          lifetime: this.lifetime,
        });
      }
      return;
    }
    void this.constructDesired();
  }

  retry = (): Promise<void> => {
    if (this.snapshot.kind === "construction-failed") {
      return this.constructDesired();
    }
    return this.startClose();
  };

  private startClose(): Promise<void> {
    const closing = this.lifetime;
    if (!closing) return Promise.resolve();
    closing.beginClose();
    this.publish({
      kind: "closing",
      authEpoch: this.authEpoch,
      closingAccountId: closing.accountId,
      desiredAccountId: this.desiredAccountId,
    });
    if (this.closeAttempt) return this.closeAttempt;
    const attempt = closing.finishClose().then(
      () => {
        if (this.lifetime === closing) this.lifetime = null;
        this.closeAttempt = null;
        if (this.desiredAccountId) void this.constructDesired();
        else this.publish({ kind: "idle", authEpoch: this.authEpoch });
      },
      (error: unknown) => {
        this.closeAttempt = null;
        const failure =
          error instanceof AccountFeatureLifetimeCloseError
            ? error
            : new AccountFeatureLifetimeCloseError("account-runtime", error);
        this.publish({
          kind: "close-failed",
          authEpoch: this.authEpoch,
          closingAccountId: closing.accountId,
          desiredAccountId: this.desiredAccountId,
          failure: {
            attempt: ++this.closeFailures,
            stage: failure.stage,
            cause: failure.cause,
          },
        });
        throw error;
      },
    );
    this.closeAttempt = attempt;
    void attempt.catch(() => undefined);
    return attempt;
  }

  private constructDesired(): Promise<void> {
    const accountId = this.desiredAccountId;
    if (!accountId) {
      this.publish({ kind: "idle", authEpoch: this.authEpoch });
      return Promise.resolve();
    }
    if (this.preparationAttempt) return this.preparationAttempt;
    this.publish({
      kind: "awaiting-composition",
      authEpoch: this.authEpoch,
      desiredAccountId: accountId,
    });
    let attempt: Promise<void> | null = null;
    const complete = () => {
      if (this.preparationAttempt === attempt) this.preparationAttempt = null;
      if (this.desiredAccountId !== accountId) {
        if (this.desiredAccountId) void this.constructDesired();
        else this.publish({ kind: "idle", authEpoch: this.authEpoch });
        return;
      }
      try {
        const lifetime = this.createLifetime(accountId);
        if (lifetime.accountId !== accountId) throw new Error("Account lifetime identity mismatch");
        this.lifetime = lifetime;
        if (!this.canonical) throw new Error("Account declaration is missing");
        this.publish({
          kind: "ready",
          authEpoch: this.authEpoch,
          declaration: this.canonical,
          lifetime,
        });
      } catch (cause) {
        this.publish({
          kind: "construction-failed",
          authEpoch: this.authEpoch,
          desiredAccountId: accountId,
          cause,
        });
      }
    };
    const fail = (cause: unknown) => {
      if (this.preparationAttempt === attempt) this.preparationAttempt = null;
      if (this.desiredAccountId !== accountId) {
        if (this.desiredAccountId) void this.constructDesired();
        return;
      }
      this.publish({
        kind: "construction-failed",
        authEpoch: this.authEpoch,
        desiredAccountId: accountId,
        cause,
      });
    };
    let preparation: Promise<void> | void;
    try {
      preparation = this.prepareAccount(accountId);
    } catch (cause) {
      fail(cause);
      return Promise.resolve();
    }
    if (!preparation) {
      complete();
      return Promise.resolve();
    }
    attempt = preparation.then(complete, fail);
    this.preparationAttempt = attempt;
    return attempt;
  }

  private publish(snapshot: AccountFeatureSupervisorSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
