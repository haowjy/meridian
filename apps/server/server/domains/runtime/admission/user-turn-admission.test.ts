/** Behavioral contract for the single writer-turn admission owner. */

import type { UserTurnAdmissionInput } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ProjectContextAvailabilityPort } from "../../context/index.js";
import type { AdmissionRecord, AdmissionTurnStarter } from "./user-turn-admission.js";
import {
  AdmissionConflictError,
  canonicalAdmissionFingerprint,
  createUserTurnAdmission,
  InvalidAdmissionError,
  parseUserMessageBlocks,
} from "./user-turn-admission.js";

const actor = "11111111-1111-4111-8111-111111111111" as never;
const threadId = "22222222-2222-4222-8222-222222222222" as never;
const documentId = "33333333-3333-4333-8333-333333333333" as never;
const projectId = "44444444-4444-4444-8444-444444444444" as never;
const uri = "uploads://@/map.png";

function input(overrides: Partial<UserTurnAdmissionInput> = {}): UserTurnAdmissionInput {
  return {
    actorUserId: actor,
    threadId,
    submissionId: "submission-1",
    connectionToken: "socket-a",
    text: "see map",
    blocks: [
      { type: "text", text: "see map" },
      { type: "image", documentId, uri },
      { type: "image", documentId, uri },
    ],
    references: [{ documentId, uri, purpose: "draft-upload", intakeId: "intake-1" }],
    ...overrides,
  };
}

function accepted() {
  return {
    kind: "accepted" as const,
    threadId,
    submissionId: "submission-1",
    userTurnId: "55555555-5555-4555-8555-555555555555" as never,
    assistantTurnId: "66666666-6666-4666-8666-666666666666" as never,
    resumeAfterSeq: "4",
    snapshotFloorNextSeq: "9",
  };
}

function harness(existing: AdmissionRecord | null = null) {
  const lookup = vi.fn(async () => existing);
  let capturedStart: Parameters<AdmissionTurnStarter["start"]>[0] | null = null;
  const starter: AdmissionTurnStarter["start"] = async (start) => {
    capturedStart = start;
    return accepted();
  };
  const availability = {
    lookup: vi.fn(async () => ({
      projectId,
      resolutionId: "resolution",
      resolutions: [
        {
          kind: "available" as const,
          documentId,
          generation: "1",
          authority: { kind: "none" as const, projectId },
          entry: {
            kind: "file" as const,
            entryId: documentId,
            uri,
            editable: false,
            disposition: "binary" as const,
            fileType: "image" as const,
            mimeType: "image/png",
            scope: { kind: "none" as const, projectId },
            sourceId: "source",
            parentId: "source",
            name: "map.png",
            aliases: [],
            path: ["map.png"],
            provisionalName: false,
          },
        },
      ],
    })),
  } as ProjectContextAvailabilityPort;
  const threadProject = vi.fn(async () => projectId);
  const service = createUserTurnAdmission({
    records: {
      lookup,
      retire: vi.fn(async (request) => ({
        kind: "retired" as const,
        submissionId: request.submissionId,
        code: "retired" as const,
      })),
    },
    availability,
    threadProject,
    starter: { start: starter },
  });
  return { service, lookup, starter, availability, threadProject, captured: () => capturedStart };
}

describe("UserTurnAdmission", () => {
  it("parses exact ordered occurrences and proves text equivalence", () => {
    const parsed = parseUserMessageBlocks(input().blocks, "see map");
    expect(parsed.map((block) => block.type)).toEqual(["text", "image", "image"]);
    expect(() => parseUserMessageBlocks([{ type: "text", text: "different" }], "see map")).toThrow(
      InvalidAdmissionError,
    );
    expect(() =>
      parseUserMessageBlocks([{ type: "text", text: "see map", extra: true }], "see map"),
    ).toThrow(InvalidAdmissionError);
  });

  it("fingerprints canonical identity and excludes the connection token", () => {
    const parsed = parseUserMessageBlocks(input().blocks, "see map");
    const first = canonicalAdmissionFingerprint({ ...input(), blocks: parsed });
    const second = canonicalAdmissionFingerprint({
      ...input({ connectionToken: "socket-b" }),
      blocks: parsed,
    });
    expect(first).toBe(second);
  });

  it("replays a complete accepted result before project, authorization, or busy work", async () => {
    const payload = input();
    const fingerprint = canonicalAdmissionFingerprint({
      ...payload,
      blocks: parseUserMessageBlocks(payload.blocks, payload.text),
    });
    const h = harness({ state: "accepted", fingerprint, response: accepted() });
    await expect(h.service.admit(payload)).resolves.toEqual({
      ...accepted(),
      kind: "already-accepted",
    });
    expect(h.threadProject).not.toHaveBeenCalled();
    expect(h.captured()).toBeNull();
  });

  it("rejects a same-key fingerprint mismatch definitely", async () => {
    const h = harness({ state: "accepted", fingerprint: "different", response: accepted() });
    await expect(h.service.admit(input())).rejects.toBeInstanceOf(AdmissionConflictError);
  });

  it("authorizes stable ID plus canonical URI, deduplicates provenance only, and preserves image occurrences", async () => {
    const h = harness();
    await expect(h.service.admit(input())).resolves.toMatchObject({ kind: "accepted" });
    const start = h.captured();
    expect(start).not.toBeNull();
    if (!start) throw new Error("starter was not called");
    expect(start.blocks).toHaveLength(3);
    expect(start.references).toEqual([
      { documentId, uri, purpose: "draft-upload", intakeId: "intake-1", relationship: "created" },
    ]);
    const mismatch = harness();
    await expect(
      mismatch.service.admit(
        input({ references: [{ documentId, uri: "uploads://@/other.png", purpose: "reference" }] }),
      ),
    ).resolves.toMatchObject({ kind: "rejected", code: "reference_unavailable" });
  });

  it("does not adopt URI-shaped prose and exposes not-seen and retirement without retry", async () => {
    const h = harness();
    const prose = input({ text: uri, blocks: [{ type: "text", text: uri }], references: [] });
    await h.service.admit(prose);
    expect(h.captured()?.references).toEqual([]);
    await expect(
      h.service.lookup({ actorUserId: actor, threadId, submissionId: "missing" }),
    ).resolves.toEqual({ kind: "not-seen", submissionId: "missing" });
    await expect(
      h.service.retire({ actorUserId: actor, threadId, submissionId: "missing" }),
    ).resolves.toEqual({ kind: "retired", submissionId: "missing", code: "retired" });
  });
});
