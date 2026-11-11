import { call } from "./api";
import { listen } from "@tauri-apps/api/event";
import type { Document, Segment } from "./types";

export interface BrowserStatus {
  sessionId: string;
  generation: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}
export interface BrowserSnapshot {
  id: string;
  sessionId: string;
  generation: number;
  title: string;
  url: string;
  segments: Segment[];
  truncated: boolean;
  translations: Record<string, string>;
  jobId: string | null;
  error: string | null;
}
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "back" | "forward" | "reload" | "focus" }
  | { kind: "bounds"; bounds: BrowserBounds };
export const browserApi = {
  events: (
    handler: (event: {
      sessionId: string;
      snapshotId: string;
      jobId: string;
      status: string;
      segmentId?: string;
      cached?: boolean;
      error?: string;
    }) => void,
  ) =>
    listen<Parameters<typeof handler>[0]>("browser-job", (event) =>
      handler(event.payload),
    ),
  open: (sessionId: string, url: string, bounds: BrowserBounds) =>
    call<void>("browser_open", { sessionId, url, bounds }),
  close: (sessionId: string) => call<void>("browser_close", { sessionId }),
  action: (sessionId: string, action: BrowserAction) =>
    call<void>("browser_action", { sessionId, action }),
  status: (sessionId: string) =>
    call<{ status: BrowserStatus; snapshot: BrowserSnapshot | null }>(
      "browser_status",
      { sessionId },
    ),
  capture: (sessionId: string) =>
    call<BrowserSnapshot>("browser_capture", { sessionId }),
  display: (
    sessionId: string,
    snapshotId: string,
    segmentIds: string[],
    bilingual: boolean,
  ) =>
    call<{ written: number; skipped: number }>("browser_display", {
      sessionId,
      snapshotId,
      segmentIds,
      bilingual,
    }),
  translate: (sessionId: string, snapshotId: string, segmentIds: string[]) =>
    call<string>("browser_translate", { sessionId, snapshotId, segmentIds }),
  save: (sessionId: string, snapshotId: string, projectId: string | null) =>
    call<Document>("browser_save", { sessionId, snapshotId, projectId }),
};
export function browserBounds(element: HTMLElement): BrowserBounds {
  const rect = element.getBoundingClientRect();
  const scale = window.devicePixelRatio;
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.max(1, Math.floor(rect.width * scale)),
    height: Math.max(1, Math.floor(rect.height * scale)),
  };
}
