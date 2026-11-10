import { useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "./api";
import { DeleteConfirmation } from "./DeleteConfirmation";
import type { Document, DocumentDeletion } from "./types";

export function DocumentDeleteButton({
  document,
  disabled,
  onDeleted,
  onError,
}: {
  document: Document;
  disabled: boolean;
  onDeleted: (result: DocumentDeletion) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [allVersions, setAllVersions] = useState(false);
  return (
    <>
      <button
        className="icon"
        aria-label="資料を削除"
        disabled={disabled}
        onClick={() => {
          setAllVersions(false);
          setOpen(true);
        }}
      >
        <Trash2 size={16} />
      </button>
      {open && (
        <DeleteConfirmation
          title="資料を削除"
          onClose={() => setOpen(false)}
          onError={onError}
          onDelete={async () => {
            const result = await api.deleteDocument(
              document.id,
              document.revision,
              allVersions,
            );
            await onDeleted(result);
            if (result.cleanupErrors.length)
              onError(
                "資料は削除しましたが、保存コピーの一部を削除できませんでした: " +
                  result.cleanupErrors.join("\n"),
              );
          }}
        >
          <p>
            「{document.title}」{allVersions ? "のすべての版" : "のこの版"}
            を削除します。すべてのプロジェクトから外れ、関連する訳文と会話履歴も削除されます。
          </p>
          <p>
            元のファイルやWebページは変更しません。他の資料も参照する保存コピー・翻訳キャッシュは残ります。進行中の翻訳・回答は中断します。
          </p>
          <label className="delete-scope">
            <input
              type="checkbox"
              checked={allVersions}
              onChange={(e) => setAllVersions(e.target.checked)}
            />
            この資料のすべての版を削除する
          </label>
        </DeleteConfirmation>
      )}
    </>
  );
}
