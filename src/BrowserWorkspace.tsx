import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Globe,
  LoaderCircle,
  RotateCcw,
  Settings2,
  Square,
} from "lucide-react";
import { api } from "./api";
import {
  browserApi,
  browserBounds,
  type BrowserSnapshot,
  type BrowserStatus,
} from "./browser";
import { chosenSegments } from "./core";
import type { Document, Project } from "./types";

type Phase =
  | { kind: "opening" }
  | { kind: "ready" }
  | { kind: "closing" }
  | { kind: "failed" };
export function BrowserWorkspace({
  url,
  projects,
  projectId,
  onReturn,
  onSettings,
  onSaved,
}: {
  url: string;
  projects: Project[];
  projectId: string;
  onReturn: () => void;
  onSettings: () => void;
  onSaved: (document: Document) => Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef("");
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [address, setAddress] = useState(url);
  const [ratio, setRatio] = useState(0);
  const [bilingual, setBilingual] = useState(false);
  const [saveProject, setSaveProject] = useState(projectId);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const report = (error: unknown) =>
    setError(String(error instanceof Error ? error.message : error));
  const chosen = useMemo(
    () => chosenSegments(snapshot?.segments || [], bilingual ? 100 : ratio),
    [snapshot?.id, ratio, bilingual],
  );
  const ready = snapshot
    ? [...chosen].filter((id) => snapshot.translations[id] !== undefined).length
    : 0;
  const job = snapshot?.jobId;
  useEffect(() => {
    let alive = true;
    let opened = false;
    let polling = false;
    let captureGeneration = -1;
    let lastGeneration = -1;
    let failedCaptures = 0;
    const id = crypto.randomUUID();
    session.current = id;
    const element = host.current;
    if (!element) return;
    const poll = async () => {
      if (!opened || !alive || polling) return;
      polling = true;
      let capturingPage = false;
      try {
        const result = await browserApi.status(id);
        if (!alive) return;
        if (lastGeneration !== result.status.generation) {
          lastGeneration = result.status.generation;
          failedCaptures = 0;
        }
        setStatus((previous) => {
          if (previous?.url !== result.status.url)
            setAddress(result.status.url);
          return result.status;
        });
        setSnapshot(result.snapshot);
        if (
          !result.status.loading &&
          !result.status.error &&
          !result.snapshot &&
          failedCaptures < 2 &&
          captureGeneration !== result.status.generation
        ) {
          captureGeneration = result.status.generation;
          capturingPage = true;
          setCapturing(true);
          const next = await browserApi.capture(id);
          if (alive) setSnapshot(next);
        }
      } catch (error) {
        if (capturingPage) {
          failedCaptures++;
          captureGeneration = -1;
        }
        if (alive) report(error);
      } finally {
        polling = false;
        if (alive) setCapturing(false);
      }
    };
    const observer = new ResizeObserver(() => {
      if (opened && alive)
        void browserApi
          .action(id, { kind: "bounds", bounds: browserBounds(element) })
          .catch(report);
    });
    observer.observe(element);
    void browserApi
      .open(id, url, browserBounds(element))
      .then(async () => {
        if (!alive) {
          await browserApi.close(id);
          return;
        }
        opened = true;
        setPhase({ kind: "ready" });
        await browserApi.action(id, {
          kind: "bounds",
          bounds: browserBounds(element),
        });
        await poll();
      })
      .catch((error) => {
        if (alive) {
          report(error);
          setPhase({ kind: "failed" });
        }
      });
    const timer = window.setInterval(() => void poll(), 350);
    return () => {
      alive = false;
      window.clearInterval(timer);
      observer.disconnect();
      void browserApi.close(id).catch(() => {});
    };
  }, [url]);
  useEffect(() => {
    if (!snapshot || phase.kind !== "ready") return;
    let alive = true;
    void browserApi
      .display(session.current, snapshot.id, [...chosen], bilingual)
      .then((result) => {
        if (alive) setSkipped(result.skipped);
      })
      .catch((error) => {
        if (alive) report(error);
      });
    return () => {
      alive = false;
    };
  }, [snapshot?.id, ratio, bilingual, phase.kind]);
  async function leave(destination: () => void | Promise<void>) {
    setPhase({ kind: "closing" });
    try {
      await browserApi.close(session.current);
      await destination();
    } catch (error) {
      report(error);
      setPhase({ kind: "failed" });
    }
  }
  async function capture() {
    setCapturing(true);
    setError("");
    try {
      setSnapshot(await browserApi.capture(session.current));
    } catch (error) {
      report(error);
    } finally {
      setCapturing(false);
    }
  }
  async function translate() {
    const current = snapshotRef.current;
    if (!current) return;
    setStarting(true);
    setError("");
    try {
      await browserApi.translate(
        session.current,
        current.id,
        [...chosen].filter((id) => current.translations[id] === undefined),
      );
      const latest = await browserApi.status(session.current);
      setSnapshot(latest.snapshot);
    } catch (error) {
      report(error);
    } finally {
      setStarting(false);
    }
  }
  async function save() {
    if (!snapshot) return;
    setSaving(true);
    try {
      const document = await browserApi.save(
        session.current,
        snapshot.id,
        saveProject || null,
      );
      await leave(() => onSaved(document));
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  }
  const disabled = phase.kind !== "ready";
  return (
    <main className="browser-workspace" data-session-id={session.current}>
      <header className="browser-header">
        <button
          onClick={() => void leave(onReturn)}
          disabled={phase.kind === "closing"}
        >
          <BookOpen size={17} />
          資料に戻る
        </button>
        <strong>
          <Globe size={18} />
          Webを読む
        </strong>
        <button
          aria-label="設定"
          onClick={() => void leave(onSettings)}
          disabled={phase.kind === "closing"}
        >
          <Settings2 size={18} />
          設定
        </button>
      </header>
      <form
        className="browser-address"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void browserApi
            .action(session.current, { kind: "navigate", url: address })
            .catch(report);
        }}
      >
        <button
          type="button"
          aria-label="戻る"
          disabled={disabled || !status?.canGoBack}
          onClick={() =>
            void browserApi
              .action(session.current, { kind: "back" })
              .catch(report)
          }
        >
          <ArrowLeft size={18} />
        </button>
        <button
          type="button"
          aria-label="進む"
          disabled={disabled || !status?.canGoForward}
          onClick={() =>
            void browserApi
              .action(session.current, { kind: "forward" })
              .catch(report)
          }
        >
          <ArrowRight size={18} />
        </button>
        <button
          type="button"
          aria-label="再読み込み"
          disabled={disabled}
          onClick={() =>
            void browserApi
              .action(session.current, { kind: "reload" })
              .catch(report)
          }
        >
          <RotateCcw size={17} />
        </button>
        <input
          aria-label="アドレス"
          type="url"
          required
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          disabled={disabled}
        />
        <button type="submit" disabled={disabled}>
          移動
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void browserApi
              .action(session.current, { kind: "focus" })
              .catch(report)
          }
        >
          ページに移る
        </button>
      </form>
      <section className="browser-tools" aria-label="Web翻訳">
        <label>
          日本語{" "}
          <input
            aria-label="日本語の割合"
            type="range"
            min="0"
            max="100"
            step="1"
            value={ratio}
            onChange={(event) => setRatio(Number(event.target.value))}
            disabled={disabled || bilingual}
          />
          <output>{ratio}%</output>
        </label>
        <label>
          <input
            type="checkbox"
            checked={bilingual}
            onChange={(event) => setBilingual(event.target.checked)}
            disabled={disabled}
          />
          原文と訳文を併記
        </label>
        {job ? (
          <button onClick={() => void api.cancel(job).catch(report)}>
            <Square size={14} />
            翻訳を中断
          </button>
        ) : (
          <button
            onClick={() => void translate()}
            disabled={
              disabled || !snapshot || ready === chosen.size || starting
            }
          >
            {starting && <LoaderCircle size={15} className="spin" />}
            不足分を翻訳
          </button>
        )}
        <button
          onClick={() => {
            setBilingual(false);
            setRatio(0);
          }}
          disabled={disabled}
        >
          原文に戻す
        </button>
        <button
          onClick={() => void capture()}
          disabled={disabled || capturing || !!job}
        >
          本文を再解析
        </button>
      </section>
      <section className="browser-save">
        <label>
          保存先{" "}
          <select
            aria-label="本文の保存先"
            value={saveProject}
            onChange={(event) => setSaveProject(event.target.value)}
          >
            <option value="">すべての資料</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void save()}
          disabled={disabled || !snapshot || saving}
        >
          原文を保存してAIに質問
        </button>
        <small>
          本文のみ保存します。元サイトのレイアウト・コード・フォーム・フレームは含みません。
        </small>
      </section>
      <div className="browser-status" role="status">
        {(phase.kind === "opening" ||
          status?.loading ||
          capturing ||
          !!job) && <LoaderCircle size={14} className="spin" />}
        <span>
          {status?.title || "Webページ"} ·{" "}
          {capturing
            ? "本文を解析中"
            : snapshot
              ? `${snapshot.segments.filter((segment) => segment.eligible).length}文中 対象${chosen.size}文・訳文あり${ready}文${ready < chosen.size ? " · 不足分を翻訳してください" : ""}`
              : "本文の読み込みを待っています"}
          {snapshot?.truncated ? " · 本文の一部のみ解析" : ""}
          {skipped ? ` · サイトが変更した${skipped}領域は保持` : ""}
        </span>
      </div>
      {(error || status?.error || snapshot?.error) && (
        <div className="browser-error" role="alert">
          {error || status?.error || snapshot?.error}
          <button onClick={() => setError("")}>通知を閉じる</button>
        </div>
      )}
      <div
        ref={host}
        className="browser-native-host"
        aria-label="元のWebページ"
      />
    </main>
  );
}
