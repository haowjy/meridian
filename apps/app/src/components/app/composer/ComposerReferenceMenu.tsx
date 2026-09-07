/** One atomic occurrence owns its context actions; TipTap supplies its live position. */
import { t } from "@lingui/core/macro";
import { closeHistory } from "@tiptap/pm/history";
import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  type AuthoritativeReference,
  createDomInputSuggestionTransport,
  createReferenceBrowserController,
} from "@/core/completion";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import { editorSuggestionHost } from "@/core/editor/suggestion-host";
import { ReferenceSuggestionMenu } from "@/features/editor/surfaces/link/AtReferenceMenu";
import { type ComposerReferenceAttrs, composerReferenceContent } from "./composer-document";

export type ComposerReferenceRuntime = {
  onOpen?: (reference: AuthoritativeReference) => void;
  catalog: AtReferenceCatalog | null;
};

export function ComposerReferenceMenu({
  editor,
  node,
  getPos,
  readRuntime,
}: NodeViewProps & {
  readRuntime: () => ComposerReferenceRuntime;
}) {
  const reference = node.attrs.reference as ComposerReferenceAttrs;
  const trigger = useRef<HTMLSpanElement>(null);
  const [changing, setChanging] = useState(false);
  // Opening before the menu releases its focus scope immediately dismisses the picker.
  const changeAfterClose = useRef(false);
  const runtime = readRuntime();
  const follow = runtime.onOpen ? () => readRuntime().onOpen?.(reference) : undefined;
  const focus = () => trigger.current?.focus();
  const replace = (next: ComposerReferenceAttrs | null) => {
    const position = getPos();
    if (
      position === undefined ||
      !editor.isEditable ||
      !editor.state.doc.nodeAt(position)?.eq(node)
    )
      return;
    const tr = closeHistory(editor.state.tr);
    if (next)
      tr.replaceWith(
        position,
        position + node.nodeSize,
        editor.schema.nodeFromJSON(composerReferenceContent(next)),
      );
    else tr.delete(position, position + node.nodeSize);
    editor.view.dispatch(tr);
    setChanging(false);
    editor.commands.focus();
  };
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <Popover open={changing} onOpenChange={setChanging}>
        <ContextMenu>
          <PopoverAnchor asChild>
            <ContextMenuTrigger asChild>
              {/* biome-ignore lint/a11y/useSemanticElements: Internal references have no browser URL; unavailable links still expose keyboard context actions. */}
              <span
                ref={trigger}
                data-composer-reference=""
                tabIndex={0}
                role="link"
                aria-disabled={!follow}
                aria-label={reference.label}
                onClick={(event) => {
                  event.preventDefault();
                  follow?.();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    follow?.();
                  }
                }}
              >
                {reference.label}
              </span>
            </ContextMenuTrigger>
          </PopoverAnchor>
          <ContextMenuContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (changeAfterClose.current) {
                changeAfterClose.current = false;
                setChanging(true);
              } else if (!changing) focus();
            }}
          >
            <ContextMenuLabel>{reference.label}</ContextMenuLabel>
            <ContextMenuLabel className="max-w-80 break-all font-normal text-muted-foreground">
              {reference.uri}
            </ContextMenuLabel>
            {follow ? <ContextMenuItem onSelect={follow}>{t`Open link`}</ContextMenuItem> : null}
            {runtime.catalog ? (
              <ContextMenuItem
                onSelect={() => {
                  changeAfterClose.current = true;
                }}
              >{t`Change reference`}</ContextMenuItem>
            ) : null}
            <ContextMenuItem onSelect={() => replace(null)}>{t`Remove reference`}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {changing && runtime.catalog ? (
          <PopoverContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              focus();
            }}
          >
            <ReferenceReplacement editor={editor} catalog={runtime.catalog} onSelect={replace} />
          </PopoverContent>
        ) : null}
      </Popover>
    </NodeViewWrapper>
  );
}

function ReferenceReplacement({
  editor,
  catalog,
  onSelect,
}: {
  editor: NodeViewProps["editor"];
  catalog: AtReferenceCatalog;
  onSelect: (reference: ComposerReferenceAttrs) => void;
}) {
  const id = useId();
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const driver = useMemo(
    () =>
      createReferenceBrowserController({
        catalog: catalog.port,
        openContext: catalog.openContext,
        label: () => catalog.label,
        onCompleteSegment: ({ prefix }) => setQuery(prefix),
        onSelect: ({ row }) =>
          selectRef.current({
            ...row.action.reference,
            spelling: row.ambiguous ? row.action.reference.uri : `[[${row.label}]]`,
            imageCapable: row.fileKind === "asset" && row.action.reference.fileType === "image",
            upload: null,
          }),
      }),
    [catalog],
  );
  useEffect(() => {
    const host = editorSuggestionHost(editor, "chrome");
    if (!input || !host) return;
    const transport = createDomInputSuggestionTransport({
      input,
      driver,
      suggestionHost: host,
      hostLeaseId: id,
      match: ({ value, selection }) =>
        selection.from === selection.to && selection.to === value.length
          ? { query: value, text: value, triggerRange: { from: 0, to: value.length } }
          : null,
    });
    input.focus();
    transport.sync();
    return transport.destroy;
  }, [editor, input, driver, id]);
  useEffect(() => {
    if (!input) return;
    input.setSelectionRange(query.length, query.length);
    input.dispatchEvent(new Event("select"));
  }, [input, query]);
  return (
    <>
      <Input
        ref={setInput}
        aria-label={t`Change reference`}
        placeholder={t`Search documents`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {input ? (
        <ReferenceSuggestionMenu
          editor={editor}
          menu={driver.menu}
          ownerId={id}
          typingElement={input}
        />
      ) : null}
    </>
  );
}
