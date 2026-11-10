import { useState } from "react";
import { Plus } from "lucide-react";
import type { ChatSession } from "./types";

export function ChatSessionBar({
  sessions,
  activeId,
  disabled,
  onSelect,
  onCreate,
  onError,
}: {
  sessions: ChatSession[];
  activeId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onCreate: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="chat-session-bar">
      <select
        aria-label="会話セッション"
        value={activeId}
        disabled={disabled || busy}
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
        disabled={disabled || busy}
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
    </div>
  );
}
