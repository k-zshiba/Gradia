import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DeleteConfirmation } from "./DeleteConfirmation";
import type { ChatSession } from "./types";

export function ChatSessionBar({
  sessions,
  activeId,
  disabled,
  onSelect,
  onCreate,
  onDelete,
  onError,
}: {
  sessions: ChatSession[];
  activeId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onCreate: () => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ChatSession | null>(null);
  return (
    <div className="chat-session-bar">
      <select
        aria-label="会話セッション"
        value={activeId}
        disabled={disabled || busy || !!deleting}
        onChange={(e) => onSelect(e.target.value)}
      >
        {!sessions.length && <option value="">会話を選択</option>}
        {sessions.map((session, index) => (
          <option key={session.id} value={session.id}>
            {session.title === "新しい会話"
              ? `新しい会話 ${index + 1}`
              : session.title}
          </option>
        ))}
      </select>
      <button
        className="icon"
        aria-label="新しい会話を作成"
        disabled={disabled || busy || !!deleting}
        onClick={async () => {
          setBusy(true);
          try {
            await onCreate();
          } catch (e) {
            onError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Plus size={16} />
      </button>
      <button
        className="icon"
        aria-label="会話を削除"
        disabled={disabled || busy || !activeId}
        onClick={() =>
          setDeleting(sessions.find((s) => s.id === activeId) || null)
        }
      >
        <Trash2 size={16} />
      </button>
      {deleting && (
        <DeleteConfirmation
          title="会話を削除"
          onClose={() => setDeleting(null)}
          onError={onError}
          onDelete={() => onDelete(deleting.id)}
        >
          <p>
            「{deleting.title}
            」の会話履歴とCodexの再開IDをGradiaから削除します。この操作は取り消せません。
          </p>
          <p>この会話の回答は中断します。資料・訳文・他の会話は残ります。</p>
        </DeleteConfirmation>
      )}
    </div>
  );
}
