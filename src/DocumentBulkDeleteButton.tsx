import { useState } from "react";
import { api } from "./api";
import { DeleteConfirmation } from "./DeleteConfirmation";
import type { Document, DocumentDeletion } from "./types";

export function DocumentBulkDeleteButton({
  documents,
  disabled,
  onDeleted,
  onBusy,
  onError,
}: {
  documents: Document[];
  disabled: boolean;
  onDeleted: (result: DocumentDeletion) => Promise<void>;
  onBusy: (busy: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const [targets, setTargets] = useState<Document[] | null>(null);
  return (
    <>
      <button
        className="danger"
        disabled={disabled || !documents.length}
        onClick={() => setTargets([...documents])}
      >
        選択した資料を削除（{documents.length}件）
      </button>
      {targets && (
        <DeleteConfirmation
          title="選択した資料を削除"
          onClose={() => setTargets(null)}
          onError={onError}
          onDelete={async () => {
            onBusy(true);
            const result: DocumentDeletion = { deleted: [], cleanupErrors: [] };
            const failed: Document[] = [];
            const errors: string[] = [];
            try {
              for (const document of targets) {
                try {
                  const removed = await api.deleteDocument(
                    document.id,
                    document.revision,
                    false,
                  );
                  result.deleted.push(...removed.deleted);
                  result.cleanupErrors.push(...removed.cleanupErrors);
                } catch (error) {
                  failed.push(document);
                  errors.push(
                    `${document.title}: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
              if (result.deleted.length) {
                try {
                  await onDeleted(result);
                } catch (error) {
                  errors.push(`一覧の更新に失敗しました: ${String(error)}`);
                }
              }
              if (result.cleanupErrors.length)
                errors.push(
                  "資料は削除しましたが、保存コピーの一部を削除できませんでした: " +
                    result.cleanupErrors.join("\n"),
                );
              if (failed.length) {
                setTargets(failed);
                throw new Error(
                  `${failed.length}件を削除できませんでした。残った資料を再試行できます。\n${errors.join("\n")}`,
                );
              }
              if (errors.length) onError(errors.join("\n"));
            } finally {
              onBusy(false);
            }
          }}
        >
          <p>
            選択した{targets.length}
            件の資料の、この版だけを削除します。すべてのプロジェクトから外れ、関連する訳文と会話履歴も削除されます。この操作は取り消せません。
          </p>
          <ul className="delete-document-targets">
            {targets.map((document) => (
              <li key={`${document.id}:${document.revision}`}>
                <strong>{document.title}</strong>
                <small>
                  {document.source} · 版 {document.revision}
                </small>
              </li>
            ))}
          </ul>
          <p>
            元のファイルやWebページは変更しません。他の資料も参照する保存コピー・翻訳キャッシュは残ります。進行中の翻訳・回答は中断します。
          </p>
        </DeleteConfirmation>
      )}
    </>
  );
}
