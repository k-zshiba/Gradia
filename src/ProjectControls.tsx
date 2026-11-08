import { useState } from "react";
import { Plus, Settings2, X } from "lucide-react";
import type { Project } from "./types";

interface Props {
  projects: Project[];
  active: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onError: (error: unknown) => void;
}

export function ProjectControls(props: Props) {
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const project = props.projects.find((p) => p.id === props.active);
  function show(mode: "create" | "edit") {
    setName(mode === "edit" ? project!.name : "");
    setConfirmDelete(false);
    setDialog(mode);
  }
  async function save(remove = false) {
    setSaving(true);
    try {
      if (remove) await props.onDelete(project!.id);
      else if (dialog === "create") await props.onCreate(name.trim());
      else await props.onRename(project!.id, name.trim());
      setDialog(null);
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="project-controls">
        <label htmlFor="project-picker">プロジェクト</label>
        <div className="project-picker-row">
          <select
            id="project-picker"
            value={props.active}
            disabled={props.disabled || saving}
            onChange={(e) => props.onSelect(e.target.value)}
          >
            <option value="">すべての資料</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.documentKeys.length}）
              </option>
            ))}
          </select>
          <button
            className="icon bordered"
            aria-label="プロジェクトを作成"
            disabled={props.disabled}
            onClick={() => show("create")}
          >
            <Plus size={15} />
          </button>
          {project && (
            <button
              className="icon"
              aria-label="プロジェクトを管理"
              disabled={props.disabled}
              onClick={() => show("edit")}
            >
              <Settings2 size={15} />
            </button>
          )}
        </div>
      </div>
      {dialog && (
        <div className="modal-backdrop">
          <section
            className="modal url-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog === "create" ? "プロジェクトを作成" : "プロジェクトを管理"
            }
          >
            <header>
              <h2>
                {dialog === "create"
                  ? "プロジェクトを作成"
                  : "プロジェクトを管理"}
              </h2>
              <button
                className="icon"
                aria-label="閉じる"
                disabled={saving}
                onClick={() => setDialog(null)}
              >
                <X size={20} />
              </button>
            </header>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="field">
                プロジェクト名
                <input
                  autoFocus
                  required
                  maxLength={80}
                  value={name}
                  disabled={saving}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="button-row">
                <button
                  className="primary"
                  type="submit"
                  disabled={saving || !name.trim()}
                >
                  {dialog === "create" ? "作成" : "名前を保存"}
                </button>
                {dialog === "edit" && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setConfirmDelete(true)}
                  >
                    プロジェクトを削除
                  </button>
                )}
              </div>
              {confirmDelete && (
                <div className="project-delete-confirm">
                  <p>
                    「{project?.name}
                    」を削除します。資料・訳文・会話履歴は「すべての資料」に残ります。
                  </p>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save(true)}
                  >
                    削除する
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setConfirmDelete(false)}
                  >
                    キャンセル
                  </button>
                </div>
              )}
            </form>
          </section>
        </div>
      )}
    </>
  );
}
