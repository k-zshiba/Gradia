import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Document,
  Translation,
  ChatMessage,
  Settings,
  Reference,
  JobEvent,
  LocalFile,
  Project,
} from "./types";
export const desktop = isTauri();
export async function call<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!desktop)
    throw new Error(
      "この操作はデスクトップアプリで利用できます。npm run desktop で起動してください。",
    );
  return invoke<T>(command, args);
}
export const api = {
  list: () => call<Document[]>("list_documents"),
  save: (
    document: Omit<Document, "id" | "revision" | "createdAt">,
    projectId: string | null = null,
  ) => call<Document>("save_document", { document, projectId }),
  projects: () => call<Project[]>("list_projects"),
  createProject: (name: string) => call<Project>("create_project", { name }),
  renameProject: (id: string, name: string) =>
    call<void>("rename_project", { id, name }),
  deleteProject: (id: string) => call<void>("delete_project", { id }),
  projectDocument: (
    projectId: string,
    id: string,
    revision: string,
    add: boolean,
  ) => call<void>("set_project_document", { projectId, id, revision, add }),
  read: (path: string) => call<LocalFile>("read_file", { path }),
  folder: (path: string) => call<string[]>("list_folder", { path }),
  fetch: (url: string) =>
    call<{ html: string; url: string }>("fetch_page", { url }),
  pdf: (id: string, revision: string) =>
    call<number[]>("read_snapshot", { id, revision }),
  preference: (
    id: string,
    revision: string,
    ratio: number,
    position: string | null,
  ) => call<void>("save_preference", { id, revision, ratio, position }),
  translations: (id: string, revision: string) =>
    call<Record<string, Translation>>("get_translations", { id, revision }),
  translate: (documentId: string, revision: string, segmentIds: string[]) =>
    call<string>("start_translation", { documentId, revision, segmentIds }),
  cancel: (jobId: string) => call<void>("cancel_job", { jobId }),
  prepareUpdate: () => call<void>("prepare_update"),
  history: (id: string, revision: string) =>
    call<ChatMessage[]>("get_history", { id, revision }),
  chat: (
    documentId: string,
    revision: string,
    question: string,
    references: Reference[],
  ) =>
    call<string>("start_chat", { documentId, revision, question, references }),
  settings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) =>
    call<void>("save_settings", { settings }),
  engine: () => call<string>("start_engine"),
  stopEngine: () => call<void>("stop_engine"),
  signIn: () => call<string>("sign_in"),
  signOut: () => call<void>("sign_out"),
  account: () => call<{ connected: boolean; email?: string }>("account_status"),
  open: (url: string) => call<void>("open_url", { url }),
  events: (handler: (e: JobEvent) => void) =>
    desktop
      ? listen<JobEvent>("study-job", (e) => handler(e.payload))
      : Promise.resolve(() => {}),
};
