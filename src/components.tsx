import { useEffect, useRef, useState } from "react";
import {
  X,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  CheckCircle2,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, desktop } from "./api";
import { monaco, getDocument, pdfOptions } from "./importers";
import type { Document, Reference, Settings } from "./types";

export function InlineText({
  text,
  onReference,
  refs = [],
}: {
  text: string;
  onReference?: (id: string) => void;
  refs?: Reference[];
}) {
  const allowed = new Set(refs.map((r) => r.id));
  const parts = text.split(
    /(`[^`\n]*`|\[ref:[^\]]+\]|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g,
  );
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`"))
          return <code key={i}>{part.slice(1, -1)}</code>;
        const ref = /^\[ref:([^\]]+)\]$/.exec(part);
        if (ref && allowed.has(ref[1]))
          return (
            <button
              className="citation"
              key={i}
              onClick={() => onReference?.(ref[1])}
            >
              参照 ↗
            </button>
          );
        const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
        if (link)
          return (
            <a
              key={i}
              href={link[2]}
              onClick={(e) => {
                if (desktop) {
                  e.preventDefault();
                  void api.open(link[2]);
                }
              }}
              target="_blank"
              rel="noreferrer"
            >
              {link[1]}
            </a>
          );
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function CodeViewer({
  document,
  onSelect,
  reveal,
}: {
  document: Document;
  onSelect: (ids: string[]) => void;
  reveal?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  useEffect(() => {
    if (!host.current) return;
    monaco.editor.defineTheme("study", {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#fafaf7",
        "editorLineNumber.foreground": "#a3aaa0",
        "editor.selectionBackground": "#d9e8ce",
      },
    });
    const instance = monaco.editor.create(host.current, {
      value: document.content,
      language: document.language || "plaintext",
      theme: "study",
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      lineHeight: 24,
      scrollBeyondLastLine: false,
      padding: { top: 22 },
      wordWrap: "off",
      contextmenu: false,
    });
    editor.current = instance;
    const subscription = instance.onDidChangeCursorSelection((e) => {
      if (e.selection.isEmpty()) return;
      const ids = [];
      for (
        let i = e.selection.startLineNumber;
        i <= e.selection.endLineNumber;
        i++
      )
        ids.push(`line${i}`);
      selectRef.current(ids);
    });
    return () => {
      subscription.dispose();
      const model = instance.getModel();
      instance.dispose();
      model?.dispose();
      editor.current = null;
    };
  }, [document.id, document.revision]);
  useEffect(() => {
    if (reveal) {
      editor.current?.revealLineInCenter(reveal);
      editor.current?.setPosition({ lineNumber: reveal, column: 1 });
    }
  }, [reveal]);
  return (
    <div
      className="code-editor"
      ref={host}
      aria-label="ソースコード（読み取り専用）"
    />
  );
}

export function PdfOriginal({
  document,
  initialPage,
  onClose,
  onError,
}: {
  document: Document;
  initialPage: number;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(initialPage);
  const [total, setTotal] = useState(1);
  const [busy, setBusy] = useState(true);
  const pdf = useRef<Awaited<ReturnType<typeof getDocument>["promise"]> | null>(
    null,
  );
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    let disposed = false;
    let loadingTask: ReturnType<typeof getDocument> | undefined;
    setBusy(true);
    void api
      .pdf(document.id, document.revision)
      .then((bytes) => {
        if (disposed) return null;
        loadingTask = getDocument({
          ...pdfOptions,
          data: new Uint8Array(bytes),
        });
        return loadingTask.promise;
      })
      .then((doc) => {
        if (disposed || !doc) return;
        pdf.current = doc;
        setTotal(doc.numPages);
        setLoaded((v) => v + 1);
      })
      .catch((error) => {
        if (!disposed) onError(error);
      });
    return () => {
      disposed = true;
      void loadingTask?.destroy().catch(() => {});
      pdf.current = null;
    };
  }, [document.id, document.revision]);
  useEffect(() => {
    let disposed = false;
    let task:
      | ReturnType<
          Awaited<
            ReturnType<NonNullable<typeof pdf.current>["getPage"]>
          >["render"]
        >
      | undefined;
    const render = async () => {
      if (!pdf.current || !canvas.current) return;
      setBusy(true);
      const p = await pdf.current.getPage(page);
      if (disposed || !canvas.current) return;
      const viewport = p.getViewport({ scale: 1.6 });
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      task = p.render({ canvas: canvas.current, viewport });
      await task.promise;
      if (!disposed) setBusy(false);
    };
    void render().catch((error) => {
      if (!disposed) onError(error);
    });
    return () => {
      disposed = true;
      task?.cancel();
    };
  }, [page, loaded]);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal pdf-modal"
        role="dialog"
        aria-modal="true"
        aria-label="PDF原本"
      >
        <header>
          <h2>原本を確認</h2>
          <span>{document.title}</span>
          <button className="icon" onClick={onClose} aria-label="原本を閉じる">
            <X size={20} />
          </button>
        </header>
        <div className="pdf-controls">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label="前の原本ページ"
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {page} / {total}
          </span>
          <button
            disabled={page >= total}
            onClick={() => setPage((p) => p + 1)}
            aria-label="次の原本ページ"
          >
            <ChevronRight size={16} />
          </button>
          {busy && <LoaderCircle className="spin" size={16} />}
        </div>
        <div className="pdf-canvas">
          <canvas ref={canvas} />
        </div>
      </section>
    </div>
  );
}

export function SettingsDialog({
  initial,
  onClose,
  onSaved,
  onError,
}: {
  initial: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
  onError: (e: unknown) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [account, setAccount] = useState<{
    connected: boolean;
    email?: string;
  }>({ connected: false });
  const [authJob, setAuthJob] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    void api.account().then(setAccount).catch(onError);
    let dispose = () => {};
    let gone = false;
    void api
      .events((e) => {
        if (e.kind === "auth") {
          setAuthJob(null);
          setMessage(e.error || "ChatGPTに接続しました");
          void api.account().then(setAccount).catch(onError);
        }
      })
      .then((fn) => {
        if (gone) fn();
        else dispose = fn;
      });
    return () => {
      gone = true;
      dispose();
    };
  }, []);
  const change = (key: keyof Settings, value: string | number) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const choose = async (key: "llamaPath" | "modelPath" | "codexPath") => {
    try {
      const path = await open({
        multiple: false,
        filters: [
          {
            name: key === "modelPath" ? "GGUF model" : "Executable",
            extensions: [key === "modelPath" ? "gguf" : "exe"],
          },
        ],
      });
      if (typeof path === "string") change(key, path);
    } catch (e) {
      onError(e);
    }
  };
  async function save() {
    setBusy(true);
    try {
      await api.saveSettings(settings);
      onSaved(settings);
      setMessage("設定を保存しました");
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="設定"
      >
        <header>
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h2>学習環境の設定</h2>
          </div>
          <button className="icon" onClick={onClose} aria-label="設定を閉じる">
            <X size={20} />
          </button>
        </header>
        <div className="settings-body">
          <h3>01　ローカル翻訳</h3>
          <p className="muted">
            PLaMo 3 Translate 2B ·
            Q4_K_Mを使用します。モデル導入後はオフラインで翻訳できます。
          </p>
          {(["llamaPath", "modelPath"] as const).map((key) => (
            <label className="field" key={key}>
              {key === "llamaPath" ? "llama-server.exe" : "PLaMo GGUFファイル"}
              <div className="path-input">
                <input
                  value={settings[key]}
                  onChange={(e) => change(key, e.target.value)}
                  placeholder={
                    key === "modelPath"
                      ? "plamo-3-translate-2b-Q4_K_M.gguf"
                      : ""
                  }
                />
                <button onClick={() => void choose(key)} disabled={!desktop}>
                  選択
                </button>
              </div>
            </label>
          ))}
          <label className="field">
            GPUに配置するレイヤー数
            <input
              type="number"
              min={0}
              max={999}
              value={settings.gpuLayers}
              onChange={(e) =>
                change(
                  "gpuLayers",
                  Math.min(999, Math.max(0, Number(e.target.value))),
                )
              }
            />
            <small>
              0はCPU実行。GPU対応のllama.cppを使用する場合だけ変更してください。
            </small>
          </label>
          <div className="button-row">
            <button
              disabled={busy || !desktop}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.saveSettings(settings);
                  onSaved(settings);
                  setMessage(await api.engine());
                } catch (e) {
                  onError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <LoaderCircle className="spin" size={15} /> : null}
              翻訳エンジンを起動
            </button>
            <button
              disabled={!desktop}
              onClick={() =>
                void api
                  .stopEngine()
                  .then(() => setMessage("翻訳エンジンを停止しました"))
                  .catch(onError)
              }
            >
              停止
            </button>
            <button
              className="text-button"
              onClick={() =>
                void api
                  .open(
                    "https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF",
                  )
                  .catch(onError)
              }
            >
              モデル配布元 <ExternalLink size={13} />
            </button>
          </div>
          <h3>02　AIとの対話</h3>
          <p className="muted">
            ChatGPTの契約枠でCodexを利用します。質問と表示された参照内容をOpenAIへ送信します。
          </p>
          <label className="field">
            codex.exe
            <div className="path-input">
              <input
                value={settings.codexPath}
                onChange={(e) => change("codexPath", e.target.value)}
              />
              <button
                onClick={() => void choose("codexPath")}
                disabled={!desktop}
              >
                選択
              </button>
            </div>
          </label>
          <label className="field">
            モデル名（任意）
            <input
              value={settings.codexModel}
              onChange={(e) => change("codexModel", e.target.value)}
              placeholder="空欄ならCodexの既定モデル"
            />
          </label>
          <div className="account-box">
            <div>
              <strong>
                {account.connected ? "ChatGPT 接続済み" : "ChatGPT 未接続"}
              </strong>
              <small>
                {account.email ||
                  "ブラウザーでサインインして利用権限を確認します。"}
              </small>
            </div>
            {account.connected ? (
              <button
                onClick={() =>
                  void api
                    .signOut()
                    .then(() => setAccount({ connected: false }))
                    .catch(onError)
                }
              >
                接続解除
              </button>
            ) : (
              <button
                disabled={!!authJob || !desktop}
                onClick={() =>
                  void api.signIn().then(setAuthJob).catch(onError)
                }
              >
                {authJob ? "サインイン待ち…" : "ChatGPTに接続"}
              </button>
            )}
            {authJob && (
              <button onClick={() => void api.cancel(authJob).catch(onError)}>
                中断
              </button>
            )}
          </div>
          {message && (
            <p className="success">
              <CheckCircle2 size={16} />
              {message}
            </p>
          )}
        </div>
        <footer>
          <span className="muted">資料・会話履歴はこのPCに保存されます。</span>
          <button
            className="primary"
            disabled={busy || !desktop}
            onClick={() => void save()}
          >
            設定を保存
          </button>
        </footer>
      </section>
    </div>
  );
}
