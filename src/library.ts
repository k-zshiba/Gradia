import { api } from "./api";
import { importFile } from "./importers";
import type { Document } from "./types";

export interface ImportResult {
  documents: Document[];
  failures: { path: string; error: string }[];
  cancelled: boolean;
}

export async function importLocalFiles(
  paths: string[],
  projectId: string | null,
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<ImportResult> {
  const files = [...new Set(paths)];
  const result: ImportResult = {
    documents: [],
    failures: [],
    cancelled: false,
  };
  for (const [index, path] of files.entries()) {
    if (signal.aborted) break;
    const label = `${index + 1} / ${files.length} · ${path.split(/[\\/]/).pop()}`;
    progress(`資料を取り込んでいます ${label}`);
    try {
      const file = await api.read(path);
      const imported = await importFile(file, (page, total) =>
        progress(`PDFを解析しています ${page} / ${total} · ${label}`),
      );
      result.documents.push(await api.save(imported, projectId));
    } catch (error) {
      result.failures.push({
        path,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }
  result.cancelled =
    signal.aborted &&
    result.documents.length + result.failures.length < files.length;
  return result;
}
