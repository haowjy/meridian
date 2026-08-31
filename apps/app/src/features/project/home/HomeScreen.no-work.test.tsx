// @vitest-environment jsdom
/** Project Home treats an authoritative empty Work catalog as executable No Work. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const submitFirstSend = vi.fn(async () => true);
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/client/query/useHomeChatFeed", () => ({ useHomeChatFeed: () => ({}) }));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ status: "ready", works: [], refetch: vi.fn() }),
}));
vi.mock("@/client/stores", () => ({
  useThreadActions: () => ({}),
  useAnnouncement: () => ({ announce: vi.fn(), announceError: vi.fn() }),
}));
vi.mock("@/features/editor/references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("./HomeFeed", () => ({ HomeFeed: () => null }));
vi.mock("./NewThreadComposerToolbar", () => ({ NewThreadComposerToolbar: () => null }));
vi.mock("./use-home-favorite-movement", () => ({
  useHomeFavoriteMovement: () => ({
    scrollRef: { current: null },
    interactionProps: {},
    capture: vi.fn(),
    commit: vi.fn(),
  }),
}));
vi.mock("./use-home-first-send-attempt", () => ({
  useHomeFirstSendAttempt: () => ({
    state: { kind: "idle" },
    busy: false,
    submitLocked: false,
    contextLocked: false,
    submit: submitFirstSend,
    updateDraft: vi.fn(),
    retry: vi.fn(),
    startOver: vi.fn(),
  }),
}));
vi.mock("@/components/app/composer", () => ({
  Composer: (props: {
    submitDisabled: boolean;
    onSubmit: (value: unknown) => Promise<unknown>;
  }) => (
    <button
      type="button"
      aria-label="Send message"
      disabled={props.submitDisabled}
      onClick={() =>
        void props.onSubmit({
          submissionId: "submission-1",
          acceptedRevision: 4,
          text: "Opening",
          blocks: [{ type: "text", text: "Opening" }],
          references: [],
          draft: {
            revision: 4,
            doc: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Opening" }] }],
            },
            selection: { anchor: 8, head: 8 },
            ownedUploads: [],
          },
        })
      }
    >
      Send
    </button>
  ),
}));

import { HomeScreen } from "./HomeScreen";

describe("HomeScreen No Work", () => {
  it("enables send and creates with workId null", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <HomeScreen projectId="project-1" onSelectThread={vi.fn()} onOpenThread={vi.fn()} />
        </QueryClientProvider>,
      ),
    );
    const send = host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(submitFirstSend).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: "submission-1" }),
      { workId: null, agentSlug: "general" },
    );
    await act(async () => root.unmount());
  });
});
