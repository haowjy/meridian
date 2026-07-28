/**
 * ProjectChatContextNavigationProvider — adapts chat-local document URI opens
 * to the project route's context-file selection contract.
 *
 * Every door routes the same way. A door that names a passage does one thing
 * more: after the route change it asks the editor runtime to land on that
 * passage. The extra step never gates the ordinary one, so a search row whose
 * passage has moved still opens its document.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useCallback } from "react";

import {
  ChatContextNavigationProvider,
  type ContextPassageAnchor,
} from "@/features/chat/ChatContextNavigation";
import {
  contextRouteTargetFromUri,
  canOpenContextUri as isContextUriRoutable,
} from "@/lib/context-uri";
import { usePassageNavigation } from "./usePassageNavigation";

type SelectContextPath = (
  path: string,
  scheme?: ProjectContextTreeScheme,
  options?: { replace?: boolean },
) => void;

export function ProjectChatContextNavigationProvider({
  projectId,
  activeWorkId,
  onSelectContextPath,
  children,
}: {
  projectId: string;
  activeWorkId: string | null;
  onSelectContextPath?: SelectContextPath;
  children: ReactNode;
}) {
  const navigateToPassage = usePassageNavigation(projectId);
  const openContextUri = useCallback(
    (uri: string, passage?: ContextPassageAnchor) => {
      if (!onSelectContextPath) return;
      const target = contextRouteTargetFromUri(uri, activeWorkId);
      if (!target) return;
      onSelectContextPath(target.path, target.scheme);
      if (passage) navigateToPassage(target, passage);
    },
    [activeWorkId, navigateToPassage, onSelectContextPath],
  );
  const canOpenContextUri = useCallback(
    (uri: string) => isContextUriRoutable(uri, activeWorkId),
    [activeWorkId],
  );

  return (
    <ChatContextNavigationProvider
      onOpenContextUri={onSelectContextPath ? openContextUri : null}
      canOpenContextUri={onSelectContextPath ? canOpenContextUri : null}
    >
      {children}
    </ChatContextNavigationProvider>
  );
}
