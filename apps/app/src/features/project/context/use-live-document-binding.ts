/** Ephemeral opener-owned binding for one concrete UI lifetime. */
import { useEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export type LiveDocumentBindingState =
  | { kind: "absent" }
  | { kind: "opening"; documentId: string }
  | { kind: "opened"; documentId: string; session: DocumentSession }
  | { kind: "failed"; documentId: string };

let bindingOwnerSequence = 0;

export function useLiveDocumentBinding({
  projectId,
  documentId,
  owner,
}: {
  projectId: string;
  documentId: string | null;
  owner: "desktop-server-tab" | "mobile-project-document-host";
}): LiveDocumentBindingState {
  const opener = useProjectDocumentLiveOpener();
  const ownerId = useRef<string | null>(null);
  ownerId.current ??= `${owner}:${++bindingOwnerSequence}`;
  const [state, setState] = useState<LiveDocumentBindingState>(
    documentId ? { kind: "opening", documentId } : { kind: "absent" },
  );

  useEffect(() => {
    if (!documentId) {
      setState({ kind: "absent" });
      return;
    }
    const attempt = new AbortController();
    let desired = true;
    let release: (() => void) | null = null;
    setState({ kind: "opening", documentId });
    void opener
      .open({ source: "server", projectId, documentId, signal: attempt.signal })
      .then(async (result) => {
        if (!desired || result.kind === "cancelled") return;
        if (result.kind !== "opened") {
          setState({ kind: "failed", documentId });
          return;
        }
        const binding = await result.admission.bind(ownerId.current as string);
        if (!desired) {
          binding.release();
          return;
        }
        release = () => binding.release();
        setState({ kind: "opened", documentId, session: binding.session });
      })
      .catch(() => {
        if (desired) setState({ kind: "failed", documentId });
      });
    return () => {
      desired = false;
      attempt.abort();
      release?.();
    };
  }, [documentId, opener, projectId]);

  return state;
}
