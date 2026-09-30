import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Only the jsdom-environment tests render into a DOM; node-environment test
// files (server routes) have no window/document, so skip the browser shims and
// cleanup there instead of throwing at setup time.
const HAS_DOM = typeof window !== "undefined";

afterEach(() => {
  if (HAS_DOM) cleanup();
});

// jsdom lacks a few browser APIs that Base UI (Select, DropdownMenu) touches
// even when its popups are closed. Stub them so components render without
// throwing. These are no-ops; tests never rely on their behavior.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.IntersectionObserver ??= NoopObserver;

if (HAS_DOM) {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    })) as typeof window.matchMedia;
  }

  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
}
