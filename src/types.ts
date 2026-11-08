export type Kind = "pdf" | "code" | "web" | "text";
export type Location = {
  page?: number;
  line?: number;
  endLine?: number;
  rect?: number[];
  anchor?: string;
};
export interface Segment {
  id: string;
  block: number;
  order: number;
  text: string;
  html?: string;
  kind: "paragraph" | "heading" | "code" | "comment" | "math" | "list";
  eligible: boolean;
  location: Location;
}
export interface Document {
  id: string;
  revision: string;
  title: string;
  kind: Kind;
  source: string;
  createdAt: number;
  segments: Segment[];
  content: string;
  warnings: string[];
  language?: string;
  ratio: number;
  position: string | null;
}
export interface Project {
  id: string;
  name: string;
  documentKeys: string[];
}
export interface Translation {
  segmentId: string;
  text: string;
  status: "pending" | "ready" | "failed";
  error?: string;
  cacheKey?: string;
}
export interface Reference {
  id: string;
  segmentId: string;
  revision: string;
  text: string;
  translation?: string;
  location: Location;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "completed" | "running" | "failed" | "interrupted";
  references: Reference[];
  createdAt: number;
}
export interface Settings {
  llamaPath: string;
  modelPath: string;
  gpuLayers: number;
  codexPath: string;
  codexModel: string;
}
export interface JobEvent {
  jobId: string;
  documentId: string;
  kind: "translation" | "chat" | "auth";
  status: "running" | "completed" | "failed" | "interrupted";
  segmentId?: string;
  text?: string;
  error?: string;
  messageId?: string;
  cached?: boolean;
}
export interface LocalFile {
  path: string;
  name: string;
  kind: Kind;
  content?: string;
  bytes?: number[];
}
