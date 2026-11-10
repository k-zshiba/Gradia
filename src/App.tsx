import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  BookOpen,
  Plus,
  FolderOpen,
  Globe,
  FileText,
  Code2,
  Search,
  Settings2,
  ArrowUpRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelRightClose,
  MessageSquare,
  Languages,
  X,
  LoaderCircle,
  Square,
  RotateCcw,
  Bookmark,
  Check,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChatSessionBar } from "./ChatSessionBar";
import { api, desktop } from "./api";
import { chosenSegments, selectReferences, sourceLabel } from "./core";
import { extractWeb } from "./importers";
import { importLocalFiles, type ImportResult } from "./library";
import { ProjectControls } from "./ProjectControls";
import { DocumentDeleteButton } from "./DocumentDeleteButton";
import { isMarkdownPath, matchesMarkdown, parseMarkdown } from "./markdown";
import { MarkdownPreview } from "./MarkdownPreview";
import { SegmentView, type SegmentDisplay } from "./SegmentView";
import {
  CodeViewer,
  InlineText,
  PdfOriginal,
  SettingsDialog,
} from "./components";
import { previewDocument, previewTranslations } from "./preview";
import { UpdateControl } from "./UpdateControl";
import type {
  Document,
  Segment,
  Settings,
  Translation,
  ChatMessage,
  ChatSession,
  JobEvent,
  Project,
} from "./types";

const defaults: Settings = {
  llamaPath: "llama-server.exe",
  modelPath: "",
  gpuLayers: 0,
  codexPath: "codex.exe",
  codexModel: "",
};
const key = (doc: Document) => `${doc.id}:${doc.revision}`;
const TypeIcon = ({ kind }: { kind: string }) =>
  kind === "code" ? (
    <Code2 size={17} />
  ) : kind === "web" ? (
    <Globe size={17} />
  ) : (
    <FileText size={17} />
  );

export default function App() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const project = projects.find((p) => p.id === projectId);
  const projectDocuments = documents.filter(
    (d) => !project || project.documentKeys.includes(key(d)),
  );
  const [manageDocuments, setManageDocuments] = useState(false);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const importAbort = useRef<AbortController | null>(null);
  const [activeKey, setActiveKey] = useState("");
  const doc = documents.find((d) => key(d) === activeKey);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState("");
  const [urlDialog, setUrlDialog] = useState(false);
  const [url, setUrl] = useState("");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [showToc, setShowToc] = useState(false);
  const [original, setOriginal] = useState<number | null>(null);
  const [translations, setTranslations] = useState<Record<string, Translation>>(
    {},
  );
  const [loaded, setLoaded] = useState(false);
  const [peek, setPeek] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<string[]>([]);
  const [visible, setVisible] = useState<string[]>([]);
  const [reveal, setReveal] = useState<number>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [translationJob, setTranslationJob] = useState<string | null>(null);
  const [chatJob, setChatJob] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<{
    documentKey: string;
    items: ChatSession[];
    activeId: string;
  }>({ documentKey: "", items: [], activeId: "" });
  const sessions =
    chatSessions.documentKey === activeKey ? chatSessions.items : [];
  const activeSession =
    chatSessions.documentKey === activeKey ? chatSessions.activeId : "";
  const chatContext = activeSession ? `${activeKey}:${activeSession}` : "";
  const chatContextRef = useRef(chatContext);
  chatContextRef.current = chatContext;
  const chatGeneration = useRef(0);
  const [leftWidth, setLeftWidth] = useState(252);
  const [rightWidth, setRightWidth] = useState(340);
  const [leftClosed, setLeftClosed] = useState(false);
  const [rightClosed, setRightClosed] = useState(false);
  const reader = useRef<HTMLDivElement>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const translationsRef = useRef(translations);
  translationsRef.current = translations;
  const currentJobs = useRef({
    translation: null as string | null,
    chat: null as string | null,
  });
  const jobContexts = useRef(new Map<string, string>());
  const early = useRef(new Map<string, JobEvent[]>());
  const translationGeneration = useRef(0);
  const error = (e: unknown) =>
    setToast(String(e instanceof Error ? e.message : e));
  const jobHandler = useRef<(e: JobEvent) => void>(() => {});
  jobHandler.current = (e) => {
    if (e.kind === "auth") return;
    const target = jobContexts.current.get(e.jobId);
    if (!target) {
      const events = early.current.get(e.jobId) || [];
      events.push(e);
      early.current.set(e.jobId, events.slice(-200));
      return;
    }
    const active =
      e.kind === "chat"
        ? chatContextRef.current === target
        : docRef.current && key(docRef.current) === target;
    if (
      e.kind === "translation" &&
      active &&
      currentJobs.current.translation === e.jobId &&
      e.segmentId
    ) {
      setTranslations((previous) => ({
        ...previous,
        [e.segmentId!]: {
          segmentId: e.segmentId!,
          text: e.text || "",
          status: e.error ? "failed" : "ready",
          error: e.error,
        },
      }));
    }
    if (e.kind === "chat" && active && e.text !== undefined) {
      setMessages((previous) =>
        previous.map((m) =>
          m.id === e.messageId
            ? {
                ...m,
                text: e.text!,
                status: e.status === "running" ? "running" : e.status,
              }
            : m,
        ),
      );
    }
    if (e.status !== "running") {
      if (
        e.kind === "translation" &&
        currentJobs.current.translation === e.jobId
      ) {
        currentJobs.current.translation = null;
        setTranslationJob(null);
      }
      if (e.kind === "chat" && currentJobs.current.chat === e.jobId) {
        currentJobs.current.chat = null;
        setChatJob(null);
      }
      if (e.error && e.error !== "interrupted" && active) error(e.error);
      if (e.kind === "chat" && active) {
        const d = docRef.current!;
        const session = target.slice(key(d).length + 1);
        void Promise.all([
          api.history(d.id, d.revision, session),
          api.sessions(d.id, d.revision),
        ])
          .then(([m, items]) => {
            if (chatContextRef.current === target) {
              setMessages(m);
              setChatSessions((previous) =>
                previous.documentKey === key(d)
                  ? { ...previous, items }
                  : previous,
              );
            }
          })
          .catch(error);
      }
      jobContexts.current.delete(e.jobId);
    }
  };
  function bindJob(job: string, target: string, kind: "chat" | "translation") {
    jobContexts.current.set(job, target);
    currentJobs.current[kind] = job;
    if (kind === "chat") setChatJob(job);
    else setTranslationJob(job);
    for (const event of early.current.get(job) || []) jobHandler.current(event);
    early.current.delete(job);
  }
  useEffect(() => {
    let alive = true;
    let dispose = () => {};
    void api
      .events((e) => jobHandler.current(e))
      .then((fn) => {
        if (alive) dispose = fn;
        else fn();
      });
    if (desktop) {
      void Promise.all([api.list(), api.settings(), api.projects()])
        .then(([docs, s, availableProjects]) => {
          if (!alive) return;
          setDocuments(docs);
          setSettings(s);
          setProjects(availableProjects);
          const savedProject = localStorage.getItem("study-project") || "";
          const restored = availableProjects.find((p) => p.id === savedProject);
          setProjectId(restored?.id || "");
          const available = restored
            ? docs.filter((d) => restored.documentKeys.includes(key(d)))
            : docs;
          const saved = restored
            ? localStorage.getItem(`study-active:${restored.id}`)
            : localStorage.getItem("study-active");
          setActiveKey(
            available.some((d) => key(d) === saved)
              ? saved!
              : available[0]
                ? key(available[0])
                : "",
          );
        })
        .catch(error);
    }
    return () => {
      alive = false;
      dispose();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 12000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setSelection([]);
    setPeek(new Set());
    setQuery("");
    setLoaded(false);
    setPage(0);
    setVisible([]);
    setTranslations({});
    setMessages([]);
    setOriginal(null);
    translationGeneration.current++;
    for (const job of [
      currentJobs.current.translation,
      currentJobs.current.chat,
    ])
      if (job && desktop) void api.cancel(job).catch(error);
    currentJobs.current = { translation: null, chat: null };
    setTranslationJob(null);
    setChatJob(null);
    if (!doc) return;
    const target = key(doc);
    let alive = true;
    if (doc.id === "sample") {
      setTranslations(previewTranslations);
      setLoaded(true);
      return;
    }
    localStorage.setItem("study-active", target);
    if (projectId) localStorage.setItem(`study-active:${projectId}`, target);
    void api
      .translations(doc.id, doc.revision)
      .then((t) => {
        if (!alive) return;
        setTranslations(t);
        setLoaded(true);
      })
      .catch(error);
    return () => {
      alive = false;
    };
  }, [activeKey]);
  useEffect(() => {
    if (!desktop || !doc || doc.id === "sample") return;
    const target = key(doc);
    let alive = true;
    void (async () => {
      let items = await api.sessions(doc.id, doc.revision);
      if (!items.length) {
        await api.createSession(doc.id, doc.revision, true);
        items = await api.sessions(doc.id, doc.revision);
      }
      if (!alive) return;
      const saved = localStorage.getItem(`study-chat:${target}`);
      setChatSessions({
        documentKey: target,
        items,
        activeId: items.find((s) => s.id === saved)?.id || items[0]?.id || "",
      });
    })().catch((e) => {
      if (alive) error(e);
    });
    return () => {
      alive = false;
    };
  }, [activeKey]);
  useEffect(() => {
    chatGeneration.current++;
    const previous = currentJobs.current.chat;
    if (previous && desktop) void api.cancel(previous).catch(error);
    currentJobs.current.chat = null;
    setChatJob(null);
    setMessages([]);
    setQuestion("");
    if (!doc || !activeSession || !desktop) return;
    const target = chatContext;
    const generation = chatGeneration.current;
    localStorage.setItem(`study-chat:${key(doc)}`, activeSession);
    let alive = true;
    void api
      .history(doc.id, doc.revision, activeSession)
      .then((m) => {
        if (
          alive &&
          chatContextRef.current === target &&
          chatGeneration.current === generation
        )
          setMessages(m);
      })
      .catch((e) => {
        if (alive) error(e);
      });
    return () => {
      alive = false;
    };
  }, [chatContext]);
  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);
  const parsedMarkdown = useMemo(
    () =>
      doc && ["text", "code"].includes(doc.kind) && isMarkdownPath(doc.source)
        ? parseMarkdown(doc.content)
        : null,
    [doc?.id, doc?.revision, doc?.content],
  );
  const markdown = useMemo(
    () =>
      doc?.language === "markdown" &&
      parsedMarkdown &&
      matchesMarkdown(parsedMarkdown, doc.segments)
        ? parsedMarkdown
        : null,
    [parsedMarkdown, doc?.segments, doc?.language],
  );
  const pages = useMemo(() => {
    if (!doc) return [[]] as Segment[][];
    if (markdown) return markdown.pages;
    if (doc.kind === "code") return [doc.segments];
    if (doc.kind === "pdf") {
      const groups = new Map<number, Segment[]>();
      for (const s of doc.segments) {
        const p = s.location.page || 1;
        groups.set(p, [...(groups.get(p) || []), s]);
      }
      return groups.size ? [...groups.values()] : [[]];
    }
    const groups: Segment[][] = [];
    for (let i = 0; i < doc.segments.length; i += 80)
      groups.push(doc.segments.slice(i, i + 80));
    return groups.length ? groups : [[]];
  }, [doc?.id, doc?.revision, markdown]);
  const shown = pages[Math.min(page, pages.length - 1)] || [];
  const chosen = useMemo(
    () =>
      chosenSegments(
        doc?.segments || [],
        doc?.bilingual ? 100 : doc?.ratio || 0,
      ),
    [doc?.segments, doc?.ratio, doc?.bilingual],
  );
  const ready = [...chosen].filter(
    (id) => translations[id]?.status === "ready",
  ).length;
  const searchResults = useMemo(
    () =>
      !query.trim() || !doc
        ? []
        : doc.segments
            .filter(
              (s) =>
                s.text
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()) ||
                (translations[s.id]?.text || "")
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
            )
            .slice(0, 100),
    [query, doc?.segments, translations],
  );
  useEffect(() => {
    const root = reader.current;
    if (!root) return;
    const visibleIds = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.segment!;
          if (e.isIntersecting) visibleIds.add(id);
          else visibleIds.delete(id);
        }
        setVisible([...visibleIds]);
      },
      { root, threshold: 0.1 },
    );
    root
      .querySelectorAll("[data-segment]")
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [activeKey, page, loaded, doc?.ratio, doc?.bilingual]);
  useEffect(() => {
    if (!doc || doc.id === "sample" || !loaded) return;
    const timer = setTimeout(
      () =>
        void api
          .preference(
            doc.id,
            doc.revision,
            doc.ratio,
            visible[0] || doc.position,
            doc.bilingual || false,
          )
          .catch(error),
      600,
    );
    return () => clearTimeout(timer);
  }, [activeKey, doc?.ratio, doc?.bilingual, visible, loaded]);
  useEffect(() => {
    if (doc?.position && loaded) {
      const index = pages.findIndex((p) =>
        p.some((s) => s.id === doc.position),
      );
      if (index >= 0) setPage(index);
      setTimeout(
        () =>
          document
            .getElementById(`segment-${doc.position}`)
            ?.scrollIntoView({ block: "start" }),
        150,
      );
    }
  }, [activeKey, loaded]);
  const refIds = useMemo(() => {
    if (!doc) return [];
    if (selection.length) {
      const first = doc.segments.findIndex((s) => s.id === selection[0]);
      const last = doc.segments.findIndex(
        (s) => s.id === selection[selection.length - 1],
      );
      return doc.segments
        .slice(Math.max(0, first - 1), last + 2)
        .map((s) => s.id);
    }
    return (
      visible.length
        ? visible
        : shown.slice(0, doc.kind === "code" ? 30 : 5).map((s) => s.id)
    ).slice(0, 40);
  }, [doc, selection, visible, page]);
  const references = useMemo(
    () =>
      doc
        ? selectReferences(
            doc,
            refIds,
            Object.fromEntries(
              Object.entries(translations)
                .filter(([, t]) => t.status === "ready")
                .map(([id, t]) => [id, t.text]),
            ),
          )
        : [],
    [doc, refIds, translations],
  );
  async function translate() {
    if (!doc || doc.id === "sample") return;
    const generation = ++translationGeneration.current;
    const target = key(doc);
    try {
      if (currentJobs.current.translation)
        await api.cancel(currentJobs.current.translation);
      const ids = [...chosen]
        .filter((id) => translationsRef.current[id]?.status !== "ready")
        .sort(
          (a, b) => Number(visible.includes(b)) - Number(visible.includes(a)),
        );
      if (!ids.length) return;
      const job = await api.translate(doc.id, doc.revision, ids);
      if (
        generation !== translationGeneration.current ||
        !docRef.current ||
        key(docRef.current) !== target
      ) {
        await api.cancel(job);
        return;
      }
      bindJob(job, target, "translation");
    } catch (e) {
      error(e);
    }
  }
  useEffect(() => {
    if (!loaded || !doc || doc.id === "sample" || !settings.modelPath) return;
    const timer = setTimeout(() => void translate(), 450);
    return () => clearTimeout(timer);
  }, [activeKey, doc?.ratio, doc?.bilingual, loaded, settings.modelPath]);
  function updateRatio(ratio: number) {
    setDocuments((list) =>
      list.map((d) => (key(d) === activeKey ? { ...d, ratio } : d)),
    );
  }
  function selectProject(id: string, availableProjects = projects) {
    const next = availableProjects.find((p) => p.id === id);
    const available = next
      ? documents.filter((d) => next.documentKeys.includes(key(d)))
      : documents;
    const saved = localStorage.getItem(
      id ? `study-active:${id}` : "study-active",
    );
    setProjectId(id);
    localStorage.setItem("study-project", id);
    const active = available.some((d) => key(d) === saved)
      ? saved!
      : available[0]
        ? key(available[0])
        : "";
    setActiveKey(active);
    if (id && active) localStorage.setItem(`study-active:${id}`, active);
    setFilter("");
  }
  async function addFiles(paths: string[]) {
    if (!paths.length) {
      setToast("このフォルダーには対応するファイルがありません");
      return;
    }
    const controller = new AbortController();
    importAbort.current = controller;
    setImportResult(null);
    setBusy("資料を取り込んでいます…");
    try {
      const result = await importLocalFiles(
        paths,
        projectId || null,
        setBusy,
        controller.signal,
      );
      const addedKeys = new Set(result.documents.map(key));
      setDocuments((list) => [
        ...result.documents,
        ...list.filter((d) => !addedKeys.has(key(d))),
      ]);
      if (result.documents[0]) setActiveKey(key(result.documents[0]));
      setImportResult(result);
      setProjects(await api.projects());
    } catch (e) {
      error(e);
    } finally {
      importAbort.current = null;
      setBusy("");
    }
  }
  async function selectFile() {
    try {
      const paths = await open({
        multiple: true,
        title: "資料を追加（複数選択できます）",
      });
      if (paths) await addFiles(typeof paths === "string" ? [paths] : paths);
    } catch (e) {
      error(e);
    }
  }
  async function upgradeMarkdown() {
    if (!doc || !parsedMarkdown) return;
    setBusy("保存済みMarkdownのプレビュー版を作成しています…");
    try {
      const saved = await api.markdown(
        doc.id,
        doc.revision,
        parsedMarkdown.segments,
      );
      setDocuments((list) => [
        saved,
        ...list.filter((d) => key(d) !== key(saved)),
      ]);
      setProjects(await api.projects());
      setActiveKey(key(saved));
    } catch (e) {
      error(e);
    } finally {
      setBusy("");
    }
  }
  async function selectFolder() {
    try {
      const path = await open({ directory: true, multiple: false });
      if (typeof path === "string") {
        setBusy("フォルダーを読み込んでいます…");
        const files = await api.folder(path);
        await addFiles(files);
      }
    } catch (e) {
      error(e);
    } finally {
      setBusy("");
    }
  }
  async function addUrl(target = url) {
    setBusy("Webページを取り込んでいます…");
    try {
      const result = await api.fetch(target);
      const article = extractWeb(result.html, result.url);
      const saved = await api.save(
        {
          ...article,
          kind: "web",
          source: result.url,
          content: "",
          ratio: 0,
          position: null,
        },
        projectId || null,
      );
      setDocuments((list) => [
        saved,
        ...list.filter((d) => key(d) !== key(saved)),
      ]);
      setActiveKey(key(saved));
      setProjects(await api.projects());
      setUrlDialog(false);
      setUrl("");
    } catch (e) {
      error(e);
    } finally {
      setBusy("");
    }
  }
  function sample() {
    setProjectId("");
    localStorage.setItem("study-project", "");
    setDocuments((list) => [
      previewDocument,
      ...list.filter((d) => d.id !== "sample"),
    ]);
    setActiveKey(key(previewDocument));
  }
  function jump(id: string) {
    if (!doc) return;
    const s = doc.segments.find((s) => s.id === id);
    if (!s) return;
    setReveal(s.location.line);
    const index = pages.findIndex((p) => p.some((s) => s.id === id));
    if (index >= 0) setPage(index);
    setQuery("");
    setShowToc(false);
    setTimeout(() => {
      const el = document.getElementById(`segment-${id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.classList.add("flash");
      setTimeout(() => el?.classList.remove("flash"), 1400);
    }, 80);
  }
  function captureSelection() {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    const ids = Array.from(
      reader.current?.querySelectorAll("[data-segment]") || [],
    )
      .filter((el) => range.intersectsNode(el))
      .map((el) => (el as HTMLElement).dataset.segment!);
    if (ids.length) setSelection(ids);
  }
  async function send() {
    if (
      !doc ||
      !activeSession ||
      !question.trim() ||
      chatJob ||
      doc.id === "sample"
    )
      return;
    const text = question.trim();
    const target = chatContext;
    const generation = ++chatGeneration.current;
    try {
      setChatJob("starting");
      const job = await api.chat(
        doc.id,
        doc.revision,
        text,
        references,
        activeSession,
      );
      if (
        chatContextRef.current !== target ||
        chatGeneration.current !== generation
      ) {
        await api.cancel(job);
        return;
      }
      setQuestion("");
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${job}`,
          role: "user",
          text,
          status: "completed",
          references,
          createdAt: Date.now(),
        },
        {
          id: job,
          role: "assistant",
          text: "",
          status: "running",
          references,
          createdAt: Date.now() + 1,
        },
      ]);
      bindJob(job, target, "chat");
    } catch (e) {
      if (
        chatGeneration.current === generation &&
        chatContextRef.current === target
      ) {
        setChatJob(null);
        error(e);
      }
    }
  }
  function resize(side: "left" | "right", start: number) {
    const initial = side === "left" ? leftWidth : rightWidth;
    const move = (e: PointerEvent) => {
      const width = initial + (e.clientX - start) * (side === "left" ? 1 : -1);
      if (side === "left") setLeftWidth(Math.max(200, Math.min(380, width)));
      else setRightWidth(Math.max(280, Math.min(520, width)));
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  }
  const segmentDisplay: SegmentDisplay = {
    chosen,
    translations,
    bilingual: !!doc?.bilingual,
    peek,
    selection,
    onPeek: (id) =>
      setPeek((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };
  const filteredDocuments = projectDocuments.filter((d) =>
    `${d.title} ${d.source}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const groupedFiles = new Map<string, Document[]>();
  const otherDocuments: Document[] = [];
  for (const d of filteredDocuments) {
    const dir = d.source.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    if (d.kind === "web" || d.id === "sample" || !dir) otherDocuments.push(d);
    else groupedFiles.set(dir, [...(groupedFiles.get(dir) || []), d]);
  }
  function documentItem(d: Document) {
    return (
      <button
        className={`document-item ${key(d) === activeKey ? "active" : ""}`}
        key={key(d)}
        title={d.source}
        onClick={() => setActiveKey(key(d))}
      >
        <span className={`type-icon ${d.kind}`}>
          <TypeIcon kind={d.kind} />
        </span>
        <span>
          <strong>{d.title}</strong>
          <small>
            {d.id === "sample"
              ? "操作サンプル"
              : `${d.language === "markdown" ? "MARKDOWN" : d.kind.toUpperCase()} · ${new Date(d.createdAt).toLocaleDateString("ja-JP")}`}
            {d.bilingual
              ? " · 英日併記"
              : d.ratio > 0 && ` · 日本語 ${d.ratio}%`}
          </small>
        </span>
      </button>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <a className="brand" onClick={() => setActiveKey("")}>
          <span className="brand-mark">
            <BookOpen size={22} />
          </span>
          <strong>
            Gra<span>dia</span>
          </strong>
          <span className="version">LOCAL WORKSPACE</span>
        </a>
        <div className="header-right">
          <UpdateControl
            beforeInstall={async () => {
              if (doc && doc.id !== "sample")
                await api.preference(
                  doc.id,
                  doc.revision,
                  doc.ratio,
                  visible[0] || doc.position,
                  doc.bilingual || false,
                );
              await api.prepareUpdate();
            }}
          />
          <span className="local-badge">
            <i />
            このPCに保存
          </span>
          <button
            className="icon"
            onClick={() => setShowSettings(true)}
            aria-label="設定"
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      {!desktop && (
        <div className="preview-banner">
          画面プレビュー ·
          サンプルで操作を確認できます。資料の保存・翻訳・AI連携はデスクトップ版で利用できます。
        </div>
      )}
      <div
        className="workspace"
        style={
          {
            "--left": `${leftClosed ? 52 : leftWidth}px`,
            "--right": `${rightClosed ? 52 : rightWidth}px`,
          } as CSSProperties
        }
      >
        <aside className={`library ${leftClosed ? "collapsed" : ""}`}>
          <div className="pane-heading">
            {!leftClosed && (
              <>
                <span>ライブラリー</span>
                <small>{projectDocuments.length}</small>
              </>
            )}
            <button
              className="icon"
              onClick={() => setLeftClosed((v) => !v)}
              aria-label="資料一覧の表示切替"
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
          {!leftClosed && (
            <>
              <ProjectControls
                projects={projects}
                active={projectId}
                disabled={!desktop || !!busy}
                onSelect={selectProject}
                onError={error}
                onCreate={async (name) => {
                  const created = await api.createProject(name);
                  const next = [...projects, created];
                  setProjects(next);
                  selectProject(created.id, next);
                }}
                onRename={async (id, name) => {
                  await api.renameProject(id, name);
                  setProjects((list) =>
                    list.map((p) => (p.id === id ? { ...p, name } : p)),
                  );
                }}
                onDelete={async (id) => {
                  await api.deleteProject(id);
                  setProjects((list) => list.filter((p) => p.id !== id));
                  selectProject("");
                }}
              />
              <div className="add-actions">
                <button
                  className="primary"
                  disabled={!!busy || !desktop}
                  onClick={() => void selectFile()}
                >
                  <Plus size={16} />
                  資料を追加
                </button>
                <button
                  className="icon bordered"
                  disabled={!desktop || !!busy}
                  onClick={() => setUrlDialog(true)}
                  aria-label="URLから追加"
                >
                  <Globe size={17} />
                </button>
                <button
                  className="icon bordered"
                  disabled={!desktop || !!busy}
                  onClick={() => void selectFolder()}
                  aria-label="フォルダーを追加"
                  title="フォルダー内の対応ファイルをまとめて追加"
                >
                  <FolderOpen size={17} />
                </button>
              </div>
              {project && (
                <button
                  className="project-members text-button"
                  disabled={!!busy}
                  onClick={() => setManageDocuments(true)}
                >
                  既存の資料を選ぶ・外す
                </button>
              )}
              <label className="library-search">
                <Search size={15} />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="資料を探す"
                  aria-label="資料を探す"
                />
              </label>
              <div className="library-scroll">
                <p className="section-label">{project?.name || "MY READING"}</p>
                {otherDocuments.map(documentItem)}
                {!projectDocuments.length && (
                  <p className="empty-library">
                    読みたい資料を、
                    <br />
                    ここに集めましょう。
                  </p>
                )}
                {[...groupedFiles].map(([dir, files]) => (
                  <details className="folder" key={dir} open>
                    <summary title={dir}>
                      <FolderOpen size={14} />
                      {dir.split("/").pop()} <small>{files.length}</small>
                    </summary>
                    {files.map(documentItem)}
                  </details>
                ))}
              </div>
              <div className="library-footer">
                <BookOpen size={16} />
                <span>少しずつ、深く理解する。</span>
              </div>
            </>
          )}
        </aside>
        <div
          className="resizer"
          role="separator"
          aria-label="資料一覧の幅"
          aria-orientation="vertical"
          onPointerDown={(e) => resize("left", e.clientX)}
        />
        <main className="reading-pane">
          {!doc ? (
            <section className="welcome">
              <span className="welcome-symbol">
                <BookOpen size={40} strokeWidth={1.3} />
              </span>
              <p className="eyebrow">A LITTLE MORE UNDERSTANDING, EVERY DAY</p>
              <h1>
                読む。問いかける。
                <br />
                <em>自分の知識にする。</em>
              </h1>
              <p>
                コードも、専門書も、Webの記事も。
                <br />
                必要な分だけ日本語にして、理解を深める場所。
              </p>
              <div className="welcome-actions">
                <button
                  className="primary"
                  disabled={!desktop}
                  onClick={() => void selectFile()}
                >
                  <Plus size={17} />
                  最初の資料を追加
                </button>
                <button onClick={sample}>
                  サンプルを開く <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="format-list">
                <span>
                  <Code2 size={18} />
                  ソースコード
                </span>
                <span>
                  <FileText size={18} />
                  PDFの書籍
                </span>
                <span>
                  <Globe size={18} />
                  Webページ
                </span>
              </div>
            </section>
          ) : (
            <>
              <div className="document-toolbar">
                <span className="breadcrumb">
                  <TypeIcon kind={doc.kind} />
                  {project?.name || "ライブラリー"} <span>/</span> {doc.title}
                </span>
                <div className="toolbar-actions">
                  <DocumentDeleteButton
                    document={doc}
                    disabled={!desktop || !!busy || doc.id === "sample"}
                    onError={error}
                    onDeleted={async (result) => {
                      const [docs, nextProjects] = await Promise.all([
                        api.list(),
                        api.projects(),
                      ]);
                      const deleted = new Set(
                        result.deleted.map((d) => `${d.id}:${d.revision}`),
                      );
                      setDocuments(docs);
                      setProjects(nextProjects);
                      if (docRef.current && deleted.has(key(docRef.current))) {
                        const group = nextProjects.find(
                          (p) => p.id === projectId,
                        );
                        const remaining = group
                          ? docs.filter((d) =>
                              group.documentKeys.includes(key(d)),
                            )
                          : docs;
                        setActiveKey(remaining[0] ? key(remaining[0]) : "");
                      }
                    }}
                  />
                  {doc.kind === "web" && (
                    <button
                      className="icon"
                      aria-label="Webページを更新"
                      onClick={() => void addUrl(doc.source)}
                      disabled={!!busy}
                    >
                      <RotateCcw size={15} />
                    </button>
                  )}
                  <button
                    className="icon"
                    aria-label="目次"
                    onClick={() => setShowToc((v) => !v)}
                  >
                    <BookOpen size={17} />
                  </button>
                </div>
              </div>
              <div className="display-mode-toolbar">
                <span>表示モード</span>
                <button
                  className="mode-switch"
                  type="button"
                  role="switch"
                  aria-checked={!!doc.bilingual}
                  aria-label="英語と日本語を併記"
                  onClick={() => {
                    setPeek(new Set());
                    setDocuments((list) =>
                      list.map((d) =>
                        key(d) === activeKey
                          ? { ...d, bilingual: !d.bilingual }
                          : d,
                      ),
                    );
                  }}
                >
                  <span className="switch-track">
                    <span />
                  </span>
                  {doc.bilingual ? "英日を併記" : "割合で切り替え"}
                </button>
              </div>
              {doc.bilingual ? (
                <div className="bilingual-toolbar">
                  <Languages size={18} />
                  原文の下に日本語訳を表示します
                </div>
              ) : (
                <div className="translation-toolbar">
                  <div>
                    <Languages size={18} />
                    <strong>日本語の割合</strong>
                  </div>
                  <span className="range-end">原文</span>
                  <input
                    aria-label="日本語の割合"
                    type="range"
                    min={0}
                    max={100}
                    value={doc.ratio}
                    onChange={(e) => updateRatio(Number(e.target.value))}
                  />
                  <output>
                    {doc.ratio}
                    <small>%</small>
                  </output>
                  <button
                    className="text-button"
                    onClick={() => updateRatio(doc.ratio === 100 ? 0 : 100)}
                  >
                    {doc.ratio === 100 ? "原文に戻す" : "全文翻訳"}
                  </button>
                </div>
              )}
              <div className="reader-meta">
                <label className="document-search">
                  <Search size={14} />
                  <input
                    placeholder="本文を検索"
                    aria-label="本文を検索"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      className="icon"
                      onClick={() => setQuery("")}
                      aria-label="検索を閉じる"
                    >
                      <X size={13} />
                    </button>
                  )}
                </label>
                <div className="translation-status">
                  {translationJob ? (
                    <>
                      <LoaderCircle size={13} className="spin" />
                      <span>
                        {ready} / {chosen.size} 文
                      </span>
                      <button
                        className="icon"
                        aria-label="翻訳を中断"
                        onClick={() =>
                          void api.cancel(translationJob).catch(error)
                        }
                      >
                        <Square size={12} />
                      </button>
                    </>
                  ) : chosen.size > 0 ? (
                    <>
                      <span>
                        {ready === chosen.size ? (
                          <Check size={13} />
                        ) : (
                          <Languages size={13} />
                        )}
                      </span>
                      <span>
                        {ready} / {chosen.size} 文
                      </span>
                      {ready < chosen.size && (
                        <button
                          className="text-button"
                          onClick={() => void translate()}
                        >
                          不足分を翻訳
                        </button>
                      )}
                    </>
                  ) : (
                    <span>原文を表示中</span>
                  )}
                </div>
              </div>
              {query && (
                <div className="search-results">
                  <small>
                    {searchResults.length} 件
                    {searchResults.length === 100 ? "（先頭100件）" : ""}
                  </small>
                  {searchResults.map((s) => (
                    <button key={s.id} onClick={() => jump(s.id)}>
                      <span>{sourceLabel(s)}</span>
                      {s.text.slice(0, 120)}
                    </button>
                  ))}
                </div>
              )}
              {showToc && (
                <div className="toc">
                  <strong>目次</strong>
                  {doc.segments
                    .filter((s) => s.kind === "heading")
                    .map((s) => (
                      <button key={s.id} onClick={() => jump(s.id)}>
                        {s.text}
                      </button>
                    ))}
                  {!doc.segments.some((s) => s.kind === "heading") && (
                    <p>この資料には見出しがありません。</p>
                  )}
                </div>
              )}
              <div
                className="reader-scroll"
                ref={reader}
                onMouseUp={captureSelection}
              >
                <article
                  className={doc.kind === "code" ? "code-article" : "article"}
                >
                  <div className="article-kicker">
                    <span>
                      {doc.id === "sample"
                        ? "GETTING STARTED"
                        : doc.language === "markdown"
                          ? "MARKDOWN"
                          : doc.kind.toUpperCase()}
                    </span>
                    <span>
                      {doc.id === "sample"
                        ? "付属サンプル・訳文は事前収録"
                        : `取得 ${new Date(doc.createdAt).toLocaleDateString("ja-JP")} · ${doc.segments.filter((s) => s.eligible).length} 文`}
                    </span>
                  </div>
                  <h1>{doc.title}</h1>
                  <div className="article-source">
                    <span title={doc.source}>{doc.source}</span>
                    {doc.kind === "web" && (
                      <button
                        className="text-button"
                        onClick={() => void api.open(doc.source).catch(error)}
                      >
                        元ページ <ArrowUpRight size={13} />
                      </button>
                    )}
                    {doc.kind === "pdf" && (
                      <button
                        className="text-button"
                        onClick={() =>
                          setOriginal(shown[0]?.location.page || 1)
                        }
                      >
                        原本を開く <ArrowUpRight size={13} />
                      </button>
                    )}
                  </div>
                  {doc.warnings.length > 0 && (
                    <details className="warnings">
                      <summary>
                        <AlertCircle size={14} />
                        取り込み時の注記（{doc.warnings.length}）
                      </summary>
                      {doc.warnings.map((w, i) => (
                        <p key={i}>{w}</p>
                      ))}
                    </details>
                  )}
                  {doc.kind === "code" && (
                    <CodeViewer
                      document={doc}
                      onSelect={setSelection}
                      reveal={reveal}
                    />
                  )}
                  {parsedMarkdown && !markdown && (
                    <div className="markdown-upgrade">
                      <p>
                        この資料は以前の表示形式で保存されています。プレビュー用の新しい版を作成すると、見出しや表を整形して翻訳できます。過去の版と会話は残ります。
                      </p>
                      <button
                        disabled={!!busy || !desktop}
                        onClick={() => void upgradeMarkdown()}
                      >
                        Markdownプレビューに更新
                      </button>
                    </div>
                  )}
                  <div className="prose">
                    {markdown ? (
                      <MarkdownPreview
                        document={markdown}
                        visible={shown}
                        display={segmentDisplay}
                        onJump={jump}
                        onError={error}
                      />
                    ) : (
                      shown
                        .filter(
                          (s) => doc.kind !== "code" || s.kind === "comment",
                        )
                        .map((s) => (
                          <SegmentView
                            key={s.id}
                            segment={s}
                            display={segmentDisplay}
                            render={(text) => (
                              <>
                                {s.kind === "comment" && (
                                  <button
                                    className="line-label"
                                    onClick={() => setReveal(s.location.line)}
                                  >
                                    {sourceLabel(s)}
                                  </button>
                                )}
                                {s.kind === "code" ? (
                                  <pre>{s.text}</pre>
                                ) : s.kind === "heading" ? (
                                  <h2>
                                    <InlineText text={text} />
                                  </h2>
                                ) : (
                                  <p>
                                    <InlineText text={text} />
                                  </p>
                                )}
                              </>
                            )}
                            renderTranslation={(text) => (
                              <InlineText text={text} />
                            )}
                          />
                        ))
                    )}
                  </div>
                  {!doc.segments.length && (
                    <div className="empty-document">
                      <FileText size={32} />
                      <h2>抽出できる本文がありません</h2>
                      <p>スキャンされたPDFは、原本表示でお読みいただけます。</p>
                      <button onClick={() => setOriginal(1)}>原本を開く</button>
                    </div>
                  )}
                  <div className="article-end">
                    <span /> <BookOpen size={16} /> <span />
                  </div>
                </article>
              </div>
              <footer className="reader-footer">
                <span>
                  <Bookmark size={13} />
                  {doc.id === "sample"
                    ? "サンプルを閲覧中"
                    : "読書位置を自動保存"}
                </span>
                <div>
                  <button
                    className="icon"
                    disabled={page === 0}
                    onClick={() => {
                      setPage((p) => p - 1);
                      reader.current?.scrollTo(0, 0);
                    }}
                    aria-label="前の本文ページ"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span>
                    {page + 1} / {pages.length}
                  </span>
                  <button
                    className="icon"
                    disabled={page >= pages.length - 1}
                    onClick={() => {
                      setPage((p) => p + 1);
                      reader.current?.scrollTo(0, 0);
                    }}
                    aria-label="次の本文ページ"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </footer>
            </>
          )}
        </main>
        <div
          className="resizer"
          role="separator"
          aria-label="AIチャットの幅"
          aria-orientation="vertical"
          onPointerDown={(e) => resize("right", e.clientX)}
        />
        <aside className={`chat-pane ${rightClosed ? "collapsed" : ""}`}>
          <div className="pane-heading">
            {!rightClosed && (
              <>
                <MessageSquare size={17} />
                <span>学習アシスタント</span>
              </>
            )}
            <button
              className="icon"
              aria-label="AIチャットの表示切替"
              onClick={() => setRightClosed((v) => !v)}
            >
              <PanelRightClose size={17} />
            </button>
          </div>
          {!rightClosed && (
            <>
              <ChatSessionBar
                sessions={sessions}
                activeId={activeSession}
                disabled={
                  !desktop ||
                  !doc ||
                  doc.id === "sample" ||
                  chatSessions.documentKey !== activeKey
                }
                onSelect={(activeId) =>
                  setChatSessions((previous) => ({ ...previous, activeId }))
                }
                onError={error}
                onCreate={async () => {
                  if (!doc) return;
                  const target = key(doc);
                  const created = await api.createSession(doc.id, doc.revision);
                  const items = await api.sessions(doc.id, doc.revision);
                  if (docRef.current && key(docRef.current) === target)
                    setChatSessions({
                      documentKey: target,
                      items,
                      activeId: created.id,
                    });
                }}
              />
              <div className="assistant-label">
                <span className="ai-mark">C</span>
                <strong>Codex</strong>
                <span>理解を、もう一歩先へ</span>
              </div>
              <div className="chat-scroll">
                {messages.length === 0 ? (
                  <div className="chat-welcome">
                    <div className="chat-emblem">
                      <MessageSquare size={25} strokeWidth={1.4} />
                    </div>
                    <h2>気になるところから。</h2>
                    <p>
                      本文やコードを選択して質問すると、
                      <br />
                      その内容に沿って解説します。
                    </p>
                    <div className="suggestions">
                      {[
                        "この部分をわかりやすく説明して",
                        "具体的な例を使って教えて",
                        "ここで大切なポイントは？",
                      ].map((q) => (
                        <button key={q} onClick={() => setQuestion(q)}>
                          {q}
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                    </div>
                    <div className="chat-note">
                      <span>読みながら、対話する</span>
                      <p>
                        質問に添付する範囲は、
                        <br />
                        下の「参照内容」で確認できます。
                      </p>
                    </div>
                  </div>
                ) : (
                  messages.map((m) => (
                    <div className={`chat-message ${m.role}`} key={m.id}>
                      <small>
                        {m.role === "user" ? "あなた" : "CODEX"}
                        {m.status === "interrupted"
                          ? " · 中断"
                          : m.status === "failed"
                            ? " · エラー"
                            : ""}
                      </small>
                      <div className="message-text">
                        <InlineText
                          text={m.text}
                          refs={m.references}
                          onReference={(id) => {
                            const ref = m.references.find((r) => r.id === id);
                            if (ref && ref.revision === doc?.revision)
                              jump(ref.segmentId);
                            else
                              error("この回答は別の版の資料を参照しています。");
                          }}
                        />
                        {m.status === "running" && !m.text && (
                          <span className="thinking">
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messageEnd} />
              </div>
              <div className="chat-bottom">
                <details className="context-preview">
                  <summary>
                    <span>
                      <FileText size={14} />
                      {selection.length ? "選択した文と前後" : "表示中の本文"}
                      <small>{references.length} 件</small>
                    </span>
                    <ChevronDown size={14} />
                  </summary>
                  <div>
                    {selection.length > 0 && (
                      <button
                        className="text-button"
                        onClick={() => setSelection([])}
                      >
                        選択を解除
                      </button>
                    )}
                    {references.map((r) => (
                      <section key={r.id}>
                        <strong>{sourceLabel(r)}</strong>
                        <p>{r.text}</p>
                        {r.translation && (
                          <p className="context-translation">{r.translation}</p>
                        )}
                      </section>
                    ))}
                    {!references.length && (
                      <p>資料を開くと参照内容が表示されます。</p>
                    )}
                  </div>
                </details>
                <div className="composer">
                  <textarea
                    aria-label="質問"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="この資料について質問する…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div>
                    <span>Ctrl + Enter で送信</span>
                    {chatJob ? (
                      <button
                        className="send"
                        disabled={chatJob === "starting"}
                        aria-label="回答を中断"
                        onClick={() => void api.cancel(chatJob).catch(error)}
                      >
                        <Square size={15} />
                      </button>
                    ) : (
                      <button
                        className="send"
                        disabled={
                          !question.trim() ||
                          !references.length ||
                          !desktop ||
                          doc?.id === "sample" ||
                          !activeSession
                        }
                        onClick={() => void send()}
                        aria-label="質問を送信"
                      >
                        <ArrowUp size={18} />
                      </button>
                    )}
                  </div>
                </div>
                <p className="chat-disclaimer">
                  AIの回答は、原文と照らし合わせて確認しましょう。
                </p>
              </div>
            </>
          )}
        </aside>
      </div>
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle className="spin" size={17} />
          {busy}
          {importAbort.current && (
            <button
              className="text-button"
              disabled={importAbort.current.signal.aborted}
              onClick={() => {
                importAbort.current?.abort();
                setBusy("現在のファイルを保存して取り込みを中断します…");
              }}
            >
              取り込みを中断
            </button>
          )}
        </div>
      )}
      {manageDocuments && project && (
        <div className="modal-backdrop">
          <section
            className="modal url-modal"
            role="dialog"
            aria-modal="true"
            aria-label="プロジェクトの資料"
          >
            <header>
              <h2>プロジェクトの資料</h2>
              <button
                className="icon"
                aria-label="閉じる"
                disabled={membershipBusy}
                onClick={() => setManageDocuments(false)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="project-document-list">
              <p>
                「{project.name}
                」に表示する資料を選びます。外した資料は「すべての資料」に残ります。
              </p>
              {documents
                .filter((d) => d.id !== "sample")
                .map((d) => (
                  <label key={key(d)} title={d.source}>
                    <input
                      type="checkbox"
                      checked={project.documentKeys.includes(key(d))}
                      disabled={membershipBusy}
                      onChange={(e) => {
                        const add = e.target.checked;
                        setMembershipBusy(true);
                        void api
                          .projectDocument(project.id, d.id, d.revision, add)
                          .then(() => {
                            const next = projects.map((p) =>
                              p.id !== project.id
                                ? p
                                : {
                                    ...p,
                                    documentKeys: add
                                      ? [...p.documentKeys, key(d)]
                                      : p.documentKeys.filter(
                                          (k) => k !== key(d),
                                        ),
                                  },
                            );
                            setProjects(next);
                            if (!add && activeKey === key(d))
                              selectProject(project.id, next);
                          })
                          .catch(error)
                          .finally(() => setMembershipBusy(false));
                      }}
                    />
                    <span>
                      <strong>{d.title}</strong>
                      <small>
                        {d.source} ·{" "}
                        {new Date(d.createdAt).toLocaleDateString("ja-JP")}
                      </small>
                    </span>
                  </label>
                ))}
              {!documents.some((d) => d.id !== "sample") && (
                <p>資料を追加すると、ここで選べます。</p>
              )}
            </div>
          </section>
        </div>
      )}
      {importResult && (
        <div className="modal-backdrop">
          <section
            className="modal url-modal"
            role="dialog"
            aria-modal="true"
            aria-label="取り込み結果"
          >
            <header>
              <h2>取り込み結果</h2>
              <button
                className="icon"
                aria-label="閉じる"
                onClick={() => setImportResult(null)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="project-document-list">
              <p>
                {importResult.documents.length}件を追加しました。
                {importResult.failures.length > 0 &&
                  `${importResult.failures.length}件を読み込めませんでした。`}
              </p>
              {importResult.cancelled && (
                <p>取り込みを中断しました。完了した資料は保存されています。</p>
              )}
              {importResult.failures.map((f) => (
                <div className="import-failure" key={f.path}>
                  <strong>{f.path}</strong>
                  <p>{f.error}</p>
                </div>
              ))}
              <button className="primary" onClick={() => setImportResult(null)}>
                資料を読む
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="alert">
          <AlertCircle size={18} />
          <span>{toast}</span>
          <button
            className="icon"
            onClick={() => setToast("")}
            aria-label="通知を閉じる"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {urlDialog && (
        <div className="modal-backdrop">
          <section
            className="modal url-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Webページを追加"
          >
            <header>
              <h2>Webページを追加</h2>
              <button
                className="icon"
                onClick={() => setUrlDialog(false)}
                aria-label="閉じる"
              >
                <X size={20} />
              </button>
            </header>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void addUrl();
              }}
            >
              <p>公開されている記事や技術文書のURLを入力してください。</p>
              <input
                type="url"
                required
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                aria-label="WebページのURL"
              />
              <button className="primary" disabled={!!busy} type="submit">
                本文を取り込む <ArrowUpRight size={16} />
              </button>
            </form>
          </section>
        </div>
      )}
      {showSettings && (
        <SettingsDialog
          initial={settings}
          onClose={() => setShowSettings(false)}
          onError={error}
          onSaved={(s) => {
            const changed =
              s.modelPath !== settings.modelPath ||
              s.llamaPath !== settings.llamaPath ||
              s.gpuLayers !== settings.gpuLayers;
            setSettings(s);
            if (changed && doc?.id !== "sample") setTranslations({});
          }}
        />
      )}
      {original !== null && doc && (
        <PdfOriginal
          document={doc}
          initialPage={original}
          onClose={() => setOriginal(null)}
          onError={error}
        />
      )}
    </div>
  );
}
