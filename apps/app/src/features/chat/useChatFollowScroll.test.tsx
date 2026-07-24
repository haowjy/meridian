/** Interaction contract for the transcript's follow/free policy. */
// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useChatFollowScroll } from "./useChatFollowScroll";

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { mode, enterFollow } = useChatFollowScroll({ scrollRef, contentRevision: 1 });
  return (
    <>
      <div ref={scrollRef} data-scroll-viewport />
      <button type="button" data-mode={mode} onClick={enterFollow}>
        Latest
      </button>
    </>
  );
}

describe("useChatFollowScroll", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("hides the latest action by re-entering follow mode when clicked", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    const viewport = host.querySelector<HTMLElement>("[data-scroll-viewport]");
    const latest = host.querySelector<HTMLButtonElement>("button");
    if (!viewport || !latest) throw new Error("follow-scroll harness did not mount");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });

    await act(async () => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    });
    expect(latest.dataset.mode).toBe("free");

    await act(async () => latest.click());

    expect(viewport.scrollTop).toBe(800);
    expect(latest.dataset.mode).toBe("follow");
    await act(async () => root.unmount());
  });
});
