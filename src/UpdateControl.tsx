import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { desktop } from "./api";
import {
  checkAtStartup,
  checkForUpdate,
  installUpdate,
  type AppUpdate,
} from "./updater";
import { version } from "../package.json";

export function UpdateControl({
  beforeInstall,
}: {
  beforeInstall: () => Promise<void>;
}) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<"idle" | "download" | "install">("idle");
  const [percent, setPercent] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = phase !== "idle";

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    setChecking(true);
    void checkAtStartup()
      .then((available) => {
        if (alive) setUpdate(available);
      })
      .catch(() => {
        /* An offline startup must not interrupt reading. */
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (update || notice) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [update, notice]);

  function dismiss() {
    if (busy) return;
    if (update) void update.close().catch(() => {});
    setUpdate(null);
    setNotice(null);
    setError("");
  }

  async function manualCheck() {
    setChecking(true);
    try {
      const available = await checkForUpdate();
      if (available) setUpdate(available);
      else setNotice("最新の安定版を利用しています。");
    } catch {
      setNotice(
        "更新を確認できませんでした。接続状態を確認して、あとでお試しください。資料の閲覧とローカル翻訳は引き続き利用できます。",
      );
    } finally {
      setChecking(false);
    }
  }

  async function accept() {
    if (!update || busy) return;
    setError("");
    setPhase("download");
    let received = 0;
    let total = 0;
    try {
      await installUpdate(
        update,
        (event) => {
          if (event.event === "Started") {
            total = event.data.contentLength || 0;
            received = 0;
          } else if (event.event === "Progress")
            received += event.data.chunkLength;
          setPercent(
            total ? Math.min(100, Math.round((received / total) * 100)) : null,
          );
        },
        async () => {
          setPhase("install");
          await beforeInstall();
        },
      );
    } catch (reason) {
      setPhase("idle");
      setError(
        `更新できませんでした。現在のバージョンで引き続き利用できます。\n${String(reason)}`,
      );
    }
  }

  return (
    <>
      <button
        className="update-check"
        title="新しいバージョンを確認"
        aria-label="更新を確認"
        onClick={() => void manualCheck()}
        disabled={!desktop || checking || busy}
      >
        <RefreshCw size={14} className={checking ? "spin" : ""} /> v{version}
      </button>
      <dialog
        className="modal update-dialog"
        ref={dialog}
        aria-labelledby="update-heading"
        onCancel={(event) => {
          event.preventDefault();
          dismiss();
        }}
      >
        <header>
          <h2 id="update-heading">
            {update ? "新しいバージョンがあります" : "更新の確認"}
          </h2>
        </header>
        <div className="update-body">
          {update ? (
            <>
              <p>
                Gradia {update.currentVersion} →{" "}
                <strong>{update.version}</strong>
              </p>
              {update.body && <pre className="update-notes">{update.body}</pre>}
              <p>
                更新しますか？
                更新後はアプリが再起動します。実行中の翻訳や回答は中断され、資料・設定・会話履歴は引き継がれます。
              </p>
              {busy && (
                <p role="status">
                  {phase === "download"
                    ? `更新をダウンロードしています${percent === null ? "…" : ` ${percent}%`}`
                    : "処理を終了して更新を適用しています…"}
                </p>
              )}
              {phase === "download" && (
                <progress
                  aria-label="更新ダウンロード"
                  max={100}
                  value={percent ?? undefined}
                />
              )}
              {error && (
                <p className="update-error" role="alert">
                  {error}
                </p>
              )}
            </>
          ) : (
            <p>{notice}</p>
          )}
        </div>
        <footer>
          <button autoFocus disabled={busy} onClick={dismiss}>
            {update ? "今は更新しない" : "閉じる"}
          </button>
          {update && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void accept()}
            >
              <Download size={15} />
              {busy ? "更新中…" : error ? "もう一度更新する" : "はい、更新する"}
            </button>
          )}
        </footer>
      </dialog>
    </>
  );
}
