import { useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function DeleteConfirmation({
  title,
  children,
  onDelete,
  onClose,
  onError,
}: {
  title: string;
  children: ReactNode;
  onDelete: () => Promise<void>;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await onDelete();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal url-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon"
            aria-label="閉じる"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="project-document-list">
          {children}
          <div className="button-row">
            <button autoFocus disabled={busy} onClick={onClose}>
              キャンセル
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "削除しています…" : "削除する"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
