/** Immutable account close fencing at the registry core. */
import { describe, expect, it } from "vitest";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

describe("DocumentSessionRegistry account lifecycle", () => {
  it("refuses an admission commit that resumes after the account close fence", async () => {
    let continueAdmission!: () => void;
    const admissionBarrier = new Promise<void>((resolve) => {
      continueAdmission = resolve;
    });
    let admissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      admissionStarted = resolve;
    });
    const registry = new DocumentSessionRegistry(
      (accountId, local) => ({
        admit: async (projectId, documentId, generation) => {
          admissionStarted();
          await admissionBarrier;
          local.installSynchronously({
            documentId,
            projectId,
            generation,
            persistenceGeneration: generation,
          });
          return {
            accountId,
            projectId,
            documentId,
            generation,
            persistenceGeneration: generation,
          };
        },
        revokeDocument: async (_projectId, _documentId, generation) => ({
          revokedThrough: generation,
          persistence: "cleared" as const,
        }),
        revokeAccess: async (_projectId, _documentId, generation) => ({
          revokedThrough: generation,
          persistence: "cleared" as const,
        }),
        reconcilePending: async () => undefined,
        beginClose: () => undefined,
        close: async () => undefined,
      }),
      0,
      "account-commit-fence",
    );

    const opening = registry.admit("project", "doc-commit-fence", "1");
    await started;
    registry.beginCloseAccountRuntime();
    continueAdmission();

    await expect(opening).rejects.toThrow(/closing/);
    await registry.closeAccountRuntime();
  });
});
