import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createLocalUntitledCrossContextLeasePort } from "./document-session-cross-context-coordination";
import { FifoWebLocks } from "./document-session-cross-context-coordination.test-support";

const accountId = "account /%" as AccountId;
const projectId = "project /%" as ProjectId;
const documentId = "document /%" as DocumentId;

describe("local Untitled cross-context lifetime", () => {
  it("uses exact separately encoded HL identity and excludes only the same key", async () => {
    const locks = new FifoWebLocks();
    const first = createLocalUntitledCrossContextLeasePort({ accountId, locks });
    const second = createLocalUntitledCrossContextLeasePort({ accountId, locks });

    const held = await first.tryAcquire(projectId, documentId);
    expect(held).not.toBeNull();
    expect(locks.activeNames()).toEqual([
      "meridian:f1d:v1:local-untitled-lifetime/account%20%2F%25/project%20%2F%25/document%20%2F%25",
    ]);
    expect(locks.history.find(({ event }) => event === "request")?.mode).toBe("exclusive");
    expect(await second.tryAcquire(projectId, documentId)).toBeNull();

    const independent = await second.tryAcquire(projectId, "other-document" as DocumentId);
    expect(independent).not.toBeNull();
    await independent?.release();
    await held?.release();
  });

  it("never queues a replacement and leaves the old HL held after a null retry", async () => {
    const locks = new FifoWebLocks();
    const owner = createLocalUntitledCrossContextLeasePort({ accountId, locks });
    const otherRealm = createLocalUntitledCrossContextLeasePort({ accountId, locks });
    const old = await owner.tryAcquire(projectId, documentId);
    const replacementId = "replacement" as DocumentId;
    const replacementOwner = await otherRealm.tryAcquire(projectId, replacementId);

    expect(await owner.tryAcquire(projectId, replacementId)).toBeNull();
    expect(locks.activeNames()).toContain(
      "meridian:f1d:v1:local-untitled-lifetime/account%20%2F%25/project%20%2F%25/document%20%2F%25",
    );
    expect(
      locks.history.filter(({ event, name }) => event === "grant" && name.endsWith("/replacement")),
    ).toHaveLength(1);

    await replacementOwner?.release();
    const retry = await owner.tryAcquire(projectId, replacementId);
    expect(retry).not.toBeNull();
    await retry?.release();
    await old?.release();
  });

  it("keeps the raw HL namespace in the sole cross-context coordinator", () => {
    const root = join(import.meta.dirname, "../..");
    const matches: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          !/\.test(?:-support)?\.[tj]sx?$/.test(entry.name) &&
          /\.[tj]sx?$/.test(entry.name)
        ) {
          if (readFileSync(path, "utf8").includes("local-untitled-lifetime")) matches.push(path);
        }
      }
    };
    walk(root);
    expect(matches).toEqual([
      join(import.meta.dirname, "document-session-cross-context-coordination.ts"),
    ]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
