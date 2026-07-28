/**
 * Project-route composition for search-match doors: turn a routed context
 * target plus the passage a search row promised into a landing in the mounted
 * editor.
 *
 * The route change is not this hook's job — the door has already made it, and
 * the document opens whether or not the passage survives. This resolves the
 * path to a document id (the tree is the only place that mapping lives), then
 * hands the anchor to the editor runtime and reports the one outcome the
 * writer needs to hear about.
 *
 * Latest-click-wins: a writer clicking through several matches gets the last
 * one, not a race between all of them.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useRef } from "react";

import { getProjectContextTree } from "@/client/api/projects-api";
import { navigateToPassage } from "@/core/editor/passage-navigation";
import { reportPassageChanged } from "@/core/editor/passage-notice-store";
import type { ContextPassageAnchor } from "@/features/chat/ChatContextNavigation";
import { LatestNavigationCoordinator } from "@/features/chat/latest-navigation-coordinator";
import { findContextFile } from "@/features/project/context/context-tree";

export type ContextRouteTarget = {
  scheme: ProjectContextTreeScheme;
  path: string;
  workId: string | null;
};

export type NavigateToPassage = (target: ContextRouteTarget, anchor: ContextPassageAnchor) => void;

export function usePassageNavigation(projectId: string): NavigateToPassage {
  const coordinator = useRef(new LatestNavigationCoordinator());
  useEffect(() => () => coordinator.current.dispose(), []);

  return useCallback(
    (target, anchor) => {
      void coordinator.current.run(async (signal) => {
        const { tree } = await getProjectContextTree(
          projectId,
          target.scheme,
          target.workId ? { workId: target.workId } : undefined,
        );
        if (signal.aborted) return;
        const file = findContextFile(tree, target.path);
        // A binary or missing file has no Yjs document to land in; the door's
        // own destination already explains both.
        if (!file?.editable) return;
        const result = await navigateToPassage({
          documentId: file.documentId,
          anchor,
          signal,
        });
        if (result.kind === "stale") reportPassageChanged(file.documentId);
      });
    },
    [projectId],
  );
}
