/** Shared TipTap draft owner for every message-authoring surface. */
import { t } from "@lingui/core/macro";
import type {
  ReferenceOccurrence,
  SubmittedReference,
  UploadIntakeResult,
  UserMessageBlock,
} from "@meridian/contracts/protocol";
import type { JSONContent } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ArrowUp, Paperclip, RotateCcw } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import type { AuthoritativeReference } from "@/core/completion";
import { ChromeKernelExtension } from "@/core/editor/chrome";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import { AtReferenceExtension } from "@/core/editor/extensions/at-reference";
import { editorSuggestionHost } from "@/core/editor/suggestion-host";
import { AtReferenceMenu } from "@/features/editor/surfaces/link/AtReferenceMenu";
import { cn } from "@/lib/utils";
import { useComposerPlaceholder } from "./placeholders";

export type ComposerDraftRevision = number;
export type ComposerSelection = Readonly<{ from: number; to: number }>;
export type ComposerOwnedUpload = Readonly<{
  intakeId: string;
  documentId: string;
  uri: UploadIntakeResult["uri"];
  locationRevision: string;
}>;
export type ComposerDraftSnapshot = Readonly<{
  revision: ComposerDraftRevision;
  doc: JSONContent;
  selection: ComposerSelection;
  ownedUploads: readonly ComposerOwnedUpload[];
}>;
export type ComposerSubmitEnvelope = Readonly<{
  submissionId: string;
  acceptedRevision: ComposerDraftRevision;
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  draft: ComposerDraftSnapshot;
}>;
export type ComposerSubmitOutcome =
  | Readonly<{ kind: "accepted"; submissionId: string; acceptedRevision: number }>
  | Readonly<{ kind: "rejected"; submissionId: string; acceptedRevision: number }>
  | Readonly<{ kind: "ambiguous"; submissionId: string; acceptedRevision: number }>;

export type ComposerUploadScope = Readonly<{ projectId: string; workId: string | null }>;
export type ComposerUploadPort = Readonly<{
  intake: (input: {
    file: File;
    intakeId: string;
    scope: ComposerUploadScope;
  }) => Promise<UploadIntakeResult>;
  deleteDraft: (input: ComposerOwnedUpload, scope: ComposerUploadScope) => Promise<void>;
}>;

type ReferenceAttrs = AuthoritativeReference & {
  spelling: string;
  imageCapable: boolean;
  upload: ComposerOwnedUpload | null;
};
type PendingAttrs = {
  intakeId: string;
  name: string;
  state: "pending" | "failed";
  error: string | null;
};

const ReferenceNode = Node.create({
  name: "composerReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ reference: { default: null } }),
  parseHTML: () => [{ tag: "span[data-composer-reference]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs.reference as ReferenceAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-reference": "",
        role: "button",
        tabindex: "0",
        "aria-label": `${value.fileType}: ${value.label}`,
      }),
      value.spelling,
    ];
  },
});
const UploadNode = Node.create({
  name: "composerUpload",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ upload: { default: null } }),
  parseHTML: () => [{ tag: "span[data-composer-upload]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs.upload as PendingAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-upload": value.state,
        "data-intake-id": value.intakeId,
        role: "button",
        tabindex: "0",
        "aria-label": `${value.state} upload: ${value.name}`,
      }),
      value.state === "pending" ? `${value.name}…` : `${value.name} (failed)`,
    ];
  },
});

export type ComposerProps = {
  onSubmit: (
    envelope: ComposerSubmitEnvelope,
  ) => ComposerSubmitOutcome | Promise<ComposerSubmitOutcome>;
  onDraftChange?: (text: string, revision: number) => void;
  onStop?: () => void;
  streaming?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  variant?: "hero" | "pinned";
  toolbarLeft?: ReactNode;
  submitDisabled?: boolean;
  busy?: boolean;
  submitDisabledReason?: string;
  uploadScope?: ComposerUploadScope;
  uploadPort?: ComposerUploadPort;
  referenceCatalog?: AtReferenceCatalog | null;
};
export type ComposerDraftRestoration = { id: string; text: string };
export type ComposerHandle = {
  focus: () => void;
  getDraft: () => string;
  snapshot: () => ComposerDraftSnapshot;
  restoreSnapshot: (snapshot: ComposerDraftSnapshot) => void;
  restoreDraft: (restoration: ComposerDraftRestoration) => boolean;
  insertReference: (
    reference: AuthoritativeReference,
    spelling: string,
    imageCapable?: boolean,
  ) => void;
};

export function serializeComposerDraft(
  doc: JSONContent,
  revision = 0,
  selection: ComposerSelection = { from: 1, to: 1 },
): ComposerSubmitEnvelope {
  const blocks: UserMessageBlock[] = [];
  const references = new Map<string, SubmittedReference>();
  const ownedUploads: ComposerOwnedUpload[] = [];
  let text = "";
  const emitText = (value: string) => {
    if (!value) return;
    text += value;
    const last = blocks.at(-1);
    if (last?.type === "text") last.text += value;
    else blocks.push({ type: "text", text: value });
  };
  const walk = (node: JSONContent, top = false) => {
    if (node.type === "text") return emitText(node.text ?? "");
    if (node.type === "hardBreak") return emitText("\n");
    if (node.type === "composerReference") {
      const value = node.attrs?.reference as ReferenceAttrs;
      const occurrence: ReferenceOccurrence = {
        type: "reference",
        text: value.spelling,
        documentId: value.documentId,
        uri: value.uri,
      };
      blocks.push(occurrence);
      text += value.spelling;
      if (value.imageCapable)
        blocks.push({ type: "image", documentId: value.documentId, uri: value.uri });
      const key = `${value.documentId}\0${value.uri}`;
      const proposed: SubmittedReference = value.upload
        ? {
            documentId: value.documentId,
            uri: value.uri,
            purpose: "draft-upload",
            intakeId: value.upload.intakeId,
          }
        : { documentId: value.documentId, uri: value.uri, purpose: "reference" };
      if (!references.has(key) || proposed.purpose === "draft-upload")
        references.set(key, proposed);
      if (
        value.upload &&
        !ownedUploads.some((upload) => upload.intakeId === value.upload?.intakeId)
      )
        ownedUploads.push(value.upload);
      return;
    }
    const children = node.content ?? [];
    children.forEach((child, index) => {
      walk(child);
      if (top && node.type === "doc" && child.type === "paragraph" && index < children.length - 1)
        emitText("\n");
    });
  };
  walk(doc, true);
  const draft = { revision, doc, selection, ownedUploads } as const;
  return {
    submissionId: crypto.randomUUID(),
    acceptedRevision: revision,
    text,
    blocks,
    references: [...references.values()],
    draft,
  };
}

function plainDoc(text: string): JSONContent {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: lines.flatMap((line, index) => [
          ...(index ? [{ type: "hardBreak" }] : []),
          ...(line ? [{ type: "text", text: line }] : []),
        ]),
      },
    ],
  };
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    onSubmit,
    onDraftChange,
    onStop,
    streaming = false,
    placeholder,
    autoFocus,
    variant = "hero",
    toolbarLeft,
    submitDisabled = false,
    busy = false,
    submitDisabledReason,
    uploadScope,
    uploadPort,
    referenceCatalog = null,
  } = props;
  const rotatingPlaceholder = useComposerPlaceholder(streaming);
  const revision = useRef(0);
  const restored = useRef(new Set<string>());
  const pendingRestorations = useRef<ComposerDraftRestoration[]>([]);
  const inFlight = useRef<ComposerSubmitEnvelope | null>(null);
  const mountedRef = useRef(true);
  const scopeRef = useRef(uploadScope);
  scopeRef.current = uploadScope;
  const referenceCatalogRef = useRef(referenceCatalog);
  referenceCatalogRef.current = referenceCatalog;
  const resolvedUploadPort = uploadPort;
  const uploadPortRef = useRef(resolvedUploadPort);
  uploadPortRef.current = resolvedUploadPort;
  const suppressDetachRef = useRef(false);
  const [pending, setPending] = useState(0);
  const [locked, setLocked] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const disabledReasonId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const intakeFilesRef = useRef(new Map<string, File>());
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ hardBreak: {} }),
      ChromeKernelExtension,
      ReferenceNode,
      UploadNode,
      AtReferenceExtension.configure({
        catalog: () => {
          const catalog = referenceCatalogRef.current;
          if (!catalog) return null;
          return {
            ...catalog,
            insertReference: (current, range, row) => {
              const reference = row.action.reference;
              const spelling = row.ambiguous ? reference.uri : `[[${reference.label}]]`;
              return current
                .chain()
                .focus()
                .insertContentAt(range, {
                  type: "composerReference",
                  attrs: {
                    reference: {
                      ...reference,
                      spelling,
                      imageCapable: row.fileKind === "asset" && reference.fileType === "image",
                      upload: null,
                    },
                  },
                })
                .run();
            },
          };
        },
        suggestionHost: (current) => editorSuggestionHost(current, "prose"),
      }),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: autoFocus,
    editorProps: {
      handleDOMEvents: {
        click: (view, event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest("[data-composer-upload=failed]")
              : null;
          if (!target) return false;
          const intakeId = target.getAttribute("data-intake-id");
          const file = intakeId ? intakeFilesRef.current.get(intakeId) : null;
          if (!file || !intakeId) return false;
          let position = -1;
          view.state.doc.descendants((node, pos) => {
            if (
              node.type.name === "composerUpload" &&
              (node.attrs.upload as PendingAttrs).intakeId === intakeId
            )
              position = pos;
          });
          if (position >= 0) void attach(file, intakeId, position);
          return true;
        },
      },
      handleClickOn: (_view, position, node) => {
        if (node.type.name !== "composerUpload") return false;
        const value = node.attrs.upload as PendingAttrs;
        if (value.state !== "failed") return false;
        const file = intakeFilesRef.current.get(value.intakeId);
        if (!file) return false;
        void attach(file, value.intakeId, position);
        return true;
      },
      attributes: {
        "aria-label": t`Message`,
        class: "composer-input min-h-10 max-h-60 overflow-y-auto px-1.5 py-1 outline-none",
      },
    },
    onCreate: ({ editor: current }) => {
      const queued = pendingRestorations.current.splice(0);
      for (const restoration of queued) {
        const text = serializeComposerDraft(current.getJSON()).text;
        current.commands.setContent(
          plainDoc(text ? `${restoration.text}\n\n${text}` : restoration.text),
        );
      }
    },
    onTransaction: ({ editor: current, transaction }) => {
      if (!transaction.docChanged) return;
      if (!suppressDetachRef.current && uploadPortRef.current && scopeRef.current) {
        const before = serializeComposerDraft(transaction.before.toJSON()).draft.ownedUploads;
        const afterIds = new Set(
          serializeComposerDraft(current.getJSON()).draft.ownedUploads.map(
            (upload) => upload.intakeId,
          ),
        );
        for (const removed of before) {
          if (!afterIds.has(removed.intakeId)) {
            void uploadPortRef.current.deleteDraft(removed, scopeRef.current);
          }
        }
      }
      revision.current += 1;
      const projection = serializeComposerDraft(current.getJSON());
      setHasContent(projection.text.length > 0 || projection.references.length > 0);
      onDraftChange?.(
        serializeComposerDraft(current.getJSON(), revision.current, {
          from: current.state.selection.from,
          to: current.state.selection.to,
        }).text,
        revision.current,
      );
    },
  });
  const snapshot = useCallback((): ComposerDraftSnapshot => {
    if (!editor)
      return {
        revision: revision.current,
        doc: plainDoc(""),
        selection: { from: 1, to: 1 },
        ownedUploads: [],
      };
    const envelope = serializeComposerDraft(editor.getJSON(), revision.current, {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    });
    return envelope.draft;
  }, [editor]);
  const restoreSnapshot = useCallback(
    (value: ComposerDraftSnapshot) => {
      if (!editor) return;
      editor.commands.setContent(value.doc, { emitUpdate: false });
      editor.commands.setTextSelection(value.selection);
      revision.current += 1;
      {
        const projection = serializeComposerDraft(editor.getJSON());
        setHasContent(projection.text.length > 0 || projection.references.length > 0);
      }
      onDraftChange?.(serializeComposerDraft(value.doc).text, revision.current);
    },
    [editor, onDraftChange],
  );
  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus(),
      getDraft: () => (editor ? serializeComposerDraft(editor.getJSON()).text : ""),
      snapshot,
      restoreSnapshot,
      restoreDraft: ({ id, text }) => {
        if (!editor || restored.current.has(id)) return true;
        restored.current.add(id);
        const current = serializeComposerDraft(editor.getJSON()).text;
        editor.commands.setContent(plainDoc(current ? `${text}\n\n${current}` : text));
        return true;
      },
      insertReference: (reference, spelling, imageCapable = false) => {
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "composerReference",
            attrs: { reference: { ...reference, spelling, imageCapable, upload: null } },
          })
          .run();
      },
    }),
    [editor, restoreSnapshot, snapshot],
  );
  useEffect(() => {
    if (!editor || pendingRestorations.current.length === 0) return;
    const queued = pendingRestorations.current.splice(0);
    for (const restoration of queued) {
      const current = serializeComposerDraft(editor.getJSON()).text;
      editor.commands.setContent(
        plainDoc(current ? `${restoration.text}\n\n${current}` : restoration.text),
      );
    }
  }, [editor]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function submit() {
    if (!editor || submitDisabled || pending || locked || inFlight.current || editor.isEmpty)
      return;
    const envelope = serializeComposerDraft(editor.getJSON(), revision.current, {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    });
    inFlight.current = envelope;
    const outcome = await Promise.resolve(onSubmit(envelope)).catch(
      (): ComposerSubmitOutcome => ({
        kind: "rejected",
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      }),
    );
    inFlight.current = null;
    if (!mountedRef.current || editor.isDestroyed) return;
    if (
      outcome.submissionId !== envelope.submissionId ||
      outcome.acceptedRevision !== envelope.acceptedRevision
    )
      return;
    if (outcome.kind === "ambiguous") {
      setLocked(true);
      return;
    }
    if (outcome.kind === "accepted" && revision.current === envelope.acceptedRevision) {
      suppressDetachRef.current = true;
      editor.commands.clearContent(true);
      suppressDetachRef.current = false;
    }
    if (outcome.kind === "rejected" && revision.current === envelope.acceptedRevision)
      restoreSnapshot(envelope.draft);
    editor.commands.focus();
  }
  async function attach(file: File, retryIntakeId?: string, retryPosition?: number) {
    if (!editor || !resolvedUploadPort || !scopeRef.current) return;
    const intakeId = retryIntakeId ?? crypto.randomUUID();
    intakeFilesRef.current.set(intakeId, file);
    const attrs: PendingAttrs = { intakeId, name: file.name, state: "pending", error: null };
    if (retryPosition === undefined) {
      editor
        .chain()
        .focus()
        .insertContent({ type: "composerUpload", attrs: { upload: attrs } })
        .run();
    } else {
      editor
        .chain()
        .setNodeSelection(retryPosition)
        .updateAttributes("composerUpload", { upload: attrs })
        .run();
    }
    setPending((n) => n + 1);
    const scope = scopeRef.current;
    try {
      const ready = await resolvedUploadPort.intake({ file, intakeId, scope });
      let position = -1;
      editor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "composerUpload" &&
          (node.attrs.upload as PendingAttrs).intakeId === intakeId
        )
          position = pos;
      });
      if (position >= 0)
        editor
          .chain()
          .setNodeSelection(position)
          .insertContent({
            type: "composerReference",
            attrs: {
              reference: {
                ...ready,
                authority: scope.workId
                  ? { kind: "work", projectId: scope.projectId, workId: scope.workId, workSlug: "" }
                  : { kind: "none", projectId: scope.projectId },
                label: file.name,
                spelling: `[[${file.name}]]`,
                imageCapable: ready.fileType === "image",
                upload: {
                  intakeId,
                  documentId: ready.documentId,
                  uri: ready.uri,
                  locationRevision: ready.locationRevision,
                },
              },
            },
          })
          .run();
    } catch (error) {
      editor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "composerUpload" &&
          (node.attrs.upload as PendingAttrs).intakeId === intakeId
        )
          editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes("composerUpload", {
              upload: {
                ...attrs,
                state: "failed",
                error: error instanceof Error ? error.message : "Upload failed",
              },
            })
            .run();
      });
    } finally {
      setPending((n) => Math.max(0, n - 1));
    }
  }
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && streaming) {
      event.preventDefault();
      onStop?.();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      (event.metaKey || event.ctrlKey || !streaming)
    ) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <div
      className={cn(
        "border border-composer-border bg-composer-surface px-4 pt-4 pb-3 focus-within:border-border-focus",
        variant === "hero" ? "rounded-composer" : "rounded-composer-pinned",
      )}
      aria-busy={busy || pending > 0 || undefined}
    >
      <EditorContent
        editor={editor}
        data-placeholder={placeholder ?? rotatingPlaceholder}
        onKeyDownCapture={keyDown}
      />
      {editor ? <AtReferenceMenu editor={editor} /> : null}
      <div className="mt-1 flex items-center gap-2">
        <div className="min-w-0 flex-1">{toolbarLeft}</div>
        {resolvedUploadPort ? (
          <>
            <input
              ref={fileRef}
              className="sr-only"
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void attach(file);
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t`Attach file`}
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip className="size-4" />
            </Button>
          </>
        ) : null}
        {locked ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t`Submission status pending`}
            disabled
          >
            <RotateCcw className="size-4" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          onClick={() => (streaming ? onStop?.() : void submit())}
          disabled={!streaming && (!hasContent || submitDisabled || pending > 0 || locked)}
          aria-label={streaming ? t`Stop` : t`Send message`}
          aria-describedby={!streaming && submitDisabledReason ? disabledReasonId : undefined}
          className={streaming ? "rounded-full" : "rounded-field"}
        >
          {streaming ? (
            <span className="size-2.5 rounded-[3px] bg-primary-foreground" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
        {submitDisabledReason ? (
          <span id={disabledReasonId} className="sr-only">
            {submitDisabledReason}
          </span>
        ) : null}
      </div>
    </div>
  );
});
