// @vitest-environment jsdom
/** Real TipTap settlement and upload-ownership behavior. */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({ t: (value: TemplateStringsArray) => value.join("") }));
vi.mock("./placeholders", () => ({ useComposerPlaceholder: () => "Write" }));

import {
  Composer,
  type ComposerHandle,
  type ComposerSubmitEnvelope,
  type ComposerSubmitOutcome,
  type ComposerUploadPort,
} from "./Composer";

let root: Root;
let host: HTMLDivElement;
async function mount(
  onSubmit: (
    value: ComposerSubmitEnvelope,
  ) => ComposerSubmitOutcome | Promise<ComposerSubmitOutcome>,
  extra: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const ref = createRef<ComposerHandle>();
  await act(async () => root.render(<Composer ref={ref} onSubmit={onSubmit} {...extra} />));
  return ref;
}
async function send() {
  await act(async () =>
    (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click(),
  );
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
});
const outcome = (
  envelope: ComposerSubmitEnvelope,
  kind: ComposerSubmitOutcome["kind"],
): ComposerSubmitOutcome => ({
  kind,
  submissionId: envelope.submissionId,
  acceptedRevision: envelope.acceptedRevision,
});
describe("Composer settlement", () => {
  it("clears only an unchanged accepted revision", async () => {
    const ref = await mount((e) => outcome(e, "accepted"));
    await act(async () => ref.current?.restoreDraft({ id: "a", text: "exact" }));
    await send();
    expect(ref.current?.getDraft()).toBe("");
  });
  it("preserves a newer revision against an older accepted result", async () => {
    let settle!: (value: ComposerSubmitOutcome) => void;
    let frozen!: ComposerSubmitEnvelope;
    const ref = await mount((e) => {
      frozen = e;
      return new Promise((r) => {
        settle = r;
      });
    });
    await act(async () => ref.current?.restoreDraft({ id: "a", text: "first" }));
    await send();
    await act(async () => ref.current?.restoreDraft({ id: "b", text: "newer" }));
    await act(async () => settle(outcome(frozen, "accepted")));
    expect(ref.current?.getDraft()).toBe("newer\n\nfirst");
  });
  it("restores the exact snapshot and selection on definite rejection", async () => {
    let frozen!: ComposerSubmitEnvelope;
    const ref = await mount((e) => {
      frozen = e;
      return outcome(e, "rejected");
    });
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 4,
        doc: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "abcdef" }] }],
        },
        selection: { from: 3, to: 5 },
        ownedUploads: [],
      }),
    );
    await send();
    expect(ref.current?.snapshot().doc).toEqual(frozen.draft.doc);
    expect(ref.current?.snapshot().selection).toEqual({ from: 3, to: 5 });
  });
  it("leaves an ambiguous draft visible and locked", async () => {
    const ref = await mount((e) => outcome(e, "ambiguous"));
    await act(async () => ref.current?.restoreDraft({ id: "a", text: "uncertain" }));
    await send();
    expect(ref.current?.getDraft()).toBe("uncertain");
    expect(
      (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
describe("Composer upload deletion", () => {
  it("deletes a detached ready draft upload but never an accepted clear", async () => {
    const deleteDraft = vi.fn(async () => {});
    const port: ComposerUploadPort = { intake: vi.fn(), deleteDraft };
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: port,
      uploadScope: { projectId: "p", workId: null },
    });
    const upload = {
      intakeId: "i",
      documentId: "01900000-0000-7000-8000-000000000001",
      uri: "uploads://@/map.png" as const,
      locationRevision: "r1",
    };
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "composerReference",
              attrs: {
                reference: {
                  documentId: upload.documentId,
                  uri: upload.uri,
                  fileType: "image",
                  authority: { kind: "none", projectId: "p" },
                  label: "map",
                  spelling: "[[map]]",
                  imageCapable: true,
                  upload,
                },
              },
            },
          ],
        },
      ],
    };
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 1,
        doc,
        selection: { from: 1, to: 2 },
        ownedUploads: [upload],
      }),
    );
    await send();
    expect(deleteDraft).not.toHaveBeenCalled();
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 2,
        doc,
        selection: { from: 1, to: 2 },
        ownedUploads: [upload],
      }),
    );
    await act(async () =>
      ref.current?.restoreSnapshot({
        revision: 3,
        doc: { type: "doc", content: [{ type: "paragraph" }] },
        selection: { from: 1, to: 1 },
        ownedUploads: [],
      }),
    );
    expect(deleteDraft).toHaveBeenCalledWith(upload, { projectId: "p", workId: null });
  });
  it("blocks pending intake, retains failure, and retries the stable intake identity", async () => {
    const intake = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage failed"))
      .mockResolvedValueOnce({
        documentId: "01900000-0000-7000-8000-000000000002",
        uri: "uploads://@/note.txt",
        fileType: "text",
        locationRevision: "r2",
      });
    const port: ComposerUploadPort = { intake, deleteDraft: vi.fn() };
    const ref = await mount((e) => outcome(e, "accepted"), {
      uploadPort: port,
      uploadScope: { projectId: "p", workId: null },
    });
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["note"], "note.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    const failed = host.querySelector('[data-composer-upload="failed"]') as HTMLElement;
    expect(failed).not.toBeNull();
    expect(
      (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => failed.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(intake).toHaveBeenCalledTimes(2);
    expect(intake.mock.calls[1]?.[0].intakeId).toBe(intake.mock.calls[0]?.[0].intakeId);
    expect(ref.current?.snapshot().ownedUploads[0]).toMatchObject({ locationRevision: "r2" });
  });
});
