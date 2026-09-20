import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Link2,
  FileText,
  Plus,
  SlidersHorizontal,
  Search,
  Play,
  Sparkles,
} from "lucide-react";
import type { ArticleReading, LessonState, SourceSearchResult } from "../../../shared/bridge";
import type { SourceRecord } from "@eve/contracts";
import { resolveYouTubeSource, sourceMomentUrl } from "../../../../../packages/media/src/youtube";
import { ActivitySurface } from "./ActivitySurface";
import "./LearningActivity.css";

const availabilityText: Record<LessonState["availability"], string> = {
  "not-open": "Video has not opened yet.",
  connecting: "Opening the YouTube player…",
  ready: "Video ready. Press play when you’re ready.",
  closed: "The player is closed. Your source stays here.",
  network:
    "The player could not connect. Your saved notes are still available.",
  "invalid-video": "This video link could not be played here.",
  "playback-error":
    "Playback is unavailable in this player. You can open the original source.",
  "removed-or-private": "This video is private or no longer available.",
  "embedding-disabled":
    "This video cannot play inside Eve. Open the original source to watch it.",
  "missing-client-identity":
    "YouTube could not open the video in Eve. Open the original source to watch it.",
  "autoplay-blocked": "Press play in the video to begin.",
  "bridge-disconnected":
    "The player connection was interrupted. Your source and notes stay here.",
  "source-changed":
    "The source changed. Choose the one you want to continue with.",
  unknown: "Playback is unavailable here. You can open the original source.",
};

export function LearningActivity({
  taskId,
  onBack,
  onTryCurve,
  beforeAttach,
  runMutation,
  overlayOpen = false,
  onSourceContext,
  initialSourceId,
  initialQuery,
  sourceKind = "article",
  onSourcesChanged,
  onAsk,
}: {
  taskId: string;
  onBack: () => void;
  onTryCurve?: () => void;
  beforeAttach: () => Promise<void>;
  runMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  overlayOpen?: boolean;
  onSourceContext: (taskId: string, sourceId: string | null) => void;
  initialSourceId?: string | null;
  initialQuery?: string;
  sourceKind?: "article" | "video";
  onSourcesChanged?: (taskId: string, sources: SourceRecord[]) => void;
  onAsk?: (text: string) => void;
}) {
  const [lesson, setLesson] = useState<LessonState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialSourceId ?? null);
  const [reading, setReading] = useState<ArticleReading | null>(null);
  const [readingError, setReadingError] = useState("");
  const [readingBusy, setReadingBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SourceSearchResult[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [passage, setPassage] = useState<{ sourceId: string; text: string; top: number; left: number } | null>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  const sourceGeneration = useRef(0);
  useEffect(() => { setSelectedId(initialSourceId ?? null); }, [taskId, initialSourceId]);
  useEffect(() => {
    if (!initialQuery) return;
    let disposed = false;
    setQuery(initialQuery); setResults(null); setError("");
    if (sourceKind === "video") { setSearching(false); setAdding(true); return; }
    setSearching(true);
    void window.eve.searchSources(taskId, initialQuery).then(next => {
      if (!disposed) setResults(next);
    }).catch(error => {
      if (!disposed) setError(error instanceof Error ? error.message : "Article search is unavailable.");
    }).finally(() => { if (!disposed) setSearching(false); });
    return () => { disposed = true; };
  }, [taskId, initialQuery, sourceKind]);
  useEffect(() => {
    let disposed = false;
    let running = false;
    active.current = true;
    const refresh = async () => {
      if (running) return;
      running = true;
      const generation = sourceGeneration.current;
      try {
        const next = await window.eve.lesson(taskId);
        if (!disposed && generation === sourceGeneration.current)
          setLesson(next);
      } catch (error) {
        if (!disposed)
          setError(
            error instanceof Error
              ? error.message
              : "Sources could not be opened.",
          );
      } finally {
        running = false;
      }
    };
    void refresh();
    const poll = setInterval(() => void refresh(), 1000);
    return () => {
      disposed = true;
      active.current = false;
      clearInterval(poll);
    };
  }, [taskId]);
  const source =
    lesson?.sources.find((item) => item.id === selectedId) ??
    lesson?.sources.find((item) => item.id === lesson.sourceId) ??
    lesson?.sources[0];
  useEffect(() => {
    if (lesson) onSourceContext(taskId, source?.id ?? null);
  }, [taskId, source?.id, !!lesson, onSourceContext]);
  const video = source?.url ? resolveYouTubeSource(source.url) : null;
  const selectPassage = () => {
    const selection = window.getSelection();
    const reader = readerRef.current;
    if (!onAsk || !source || !reader || !selection?.rangeCount || !selection.anchorNode || !selection.focusNode ||
      !reader.contains(selection.anchorNode) || !reader.contains(selection.focusNode) || !selection.toString().trim()) {
      setPassage(null); return;
    }
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    const container = reader.getBoundingClientRect();
    setPassage({ sourceId: source.id, text: selection.toString().trim().slice(0, 3000),
      top: bounds.bottom - container.top + reader.scrollTop + 8,
      left: Math.max(8, Math.min(bounds.left - container.left, reader.clientWidth - 205)) });
  };
  useEffect(() => {
    let disposed = false;
    setReading(null); setReadingError(""); setReadingBusy(false);
    if (source?.url && !source.assetId && !video?.supported) {
      setReadingBusy(true);
      void window.eve.readSource(taskId, source.id).then(value => {
        if (!disposed) setReading(value);
      }).catch(error => {
        if (!disposed) setReadingError(error instanceof Error ? error.message : "This article could not be read here.");
      }).finally(() => { if (!disposed) setReadingBusy(false); });
    }
    return () => { disposed = true; };
  }, [taskId, source?.id, source?.url, source?.assetId, video?.supported]);
  const availability =
    lesson?.sourceId === source?.id
      ? (lesson?.availability ?? "not-open")
      : "not-open";
  const checkpoint =
    lesson?.checkpoint && lesson.checkpoint.scope.sourceId === source?.id
      ? lesson.checkpoint
      : null;
  const position = checkpoint
    ? `${Math.floor(checkpoint.snapshot.currentTime / 60)}:${String(Math.floor(checkpoint.snapshot.currentTime % 60)).padStart(2, "0")}`
    : null;
  const saveSource = async (sourceUrl: string, sourceTitle: string) => {
    if (busy || !sourceUrl.trim()) return;
    setBusy(true);
    sourceGeneration.current++;
    setError("");
    try {
      const sources = await runMutation(async () => {
        await beforeAttach();
        return window.eve.attachSource(taskId, sourceUrl.trim(), sourceTitle.trim() || new URL(sourceUrl).hostname);
      });
      if (!active.current) return;
      onSourcesChanged?.(taskId, sources);
      setLesson((previous) => ({
        sources,
        sourceId: previous?.sourceId ?? null,
        availability: previous?.availability ?? "not-open",
        checkpoint: previous?.checkpoint ?? null,
      }));
      const normalizedVideo = resolveYouTubeSource(sourceUrl.trim());
      const normalizedUrl = normalizedVideo.supported
        ? normalizedVideo.source.startSeconds ? sourceMomentUrl(normalizedVideo.source, normalizedVideo.source.startSeconds) : normalizedVideo.source.url
        : new URL(sourceUrl.trim()).href;
      const added = sources.find(item => item.url === normalizedUrl) ?? sources.find(
        (item) => !lesson?.sources.some((previous) => previous.id === item.id),
      );
      if (added) setSelectedId(added.id);
      setAdding(false);
      setTitle("");
      setUrl("");
    } catch (error) {
      if (active.current)
        setError(
          error instanceof Error
            ? error.message
            : "This source could not be saved.",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const attach = async (event: React.FormEvent) => {
    event.preventDefault();
    await saveSource(url, title);
  };
  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim() || searching) return;
    setSearching(true); setError(""); setResults(null);
    try {
      const next = await window.eve.searchSources(taskId, query.trim());
      if (active.current) setResults(next);
    } catch (error) {
      if (active.current) setError(error instanceof Error ? error.message : "Article search is unavailable.");
    } finally { if (active.current) setSearching(false); }
  };
  return (
    <section className="learning-activity" aria-label="Sources and learning">
      <div className="activity-toolbar">
        <span className="activity-title">
          <BookOpen size={16} />Alongside your work
        </span>
        <button
          className="learning-add"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
        >
          <Plus size={14} />
            Add a link
        </button>
      </div>
      <div className="learning-content">
        <div className="lesson-view">
          {source ? (
            <>
              <div className="lesson-heading">
                <div>
                  <span className="eyebrow">
                    {source.assetId
                      ? "SAVED MATERIAL"
                      : video?.supported
                        ? "YOUTUBE SOURCE"
                        : "ARTICLE"}
                  </span>
                  <h2>{source.title.replace(/ · Authored notes$/, "")}</h2>
                </div>
                {(source.url || source.assetId) && (
                  <button
                    className="quiet-button"
                    onClick={() =>
                      void window.eve
                        .openSource(taskId, source.id)
                        .catch((error: Error) => setError(error.message))
                    }
                  >
                    {source.assetId ? "Open material" : "Open original"}
                    <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
              {video?.supported ? (
                <>
                  <ActivitySurface
                    kind="video"
                    taskId={taskId}
                    sourceId={source.id}
                    coveredMessage={
                      overlayOpen
                        ? `${source.title.replace(/ · Authored notes$/, "")} · Video paused`
                        : undefined
                    }
                  />
                  <div className="lesson-player-status" role="status">
                    <span>
                      {overlayOpen
                        ? "Video paused while this panel is open."
                        : availability === "ready" &&
                            checkpoint?.snapshot.playbackState === "playing"
                          ? "Playing from the original source"
                          : availabilityText[availability]}
                    </span>
                    {position && (
                      <span>
                        {checkpoint?.snapshot.playbackState === "playing"
                          ? "At"
                          : "Last position"}{" "}
                        {position}
                      </span>
                    )}
                  </div>
                </>
              ) : source.url && !source.assetId ? (
                <div className="article-reader" ref={readerRef} onMouseUp={selectPassage} onKeyUp={selectPassage} aria-busy={readingBusy}>
                  {readingBusy ? <div className="article-loading" role="status"><span className="eyebrow">OPENING THE ORIGINAL</span><p>Bringing this article into your space…</p><i /><i /><i /><i /></div> : reading ? <>
                    <div className="article-source-line"><Link2 size={13} />{new URL(reading.url).hostname}<span>Read in this session</span></div>
                    {reading.text.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                    {reading.truncated && <div className="article-limit">This is the beginning of the article. Open the original to keep reading.</div>}
                    {passage?.sourceId === source.id && onAsk && <button className="article-context-action" style={{ top: passage.top, left: passage.left }} onMouseDown={event => event.preventDefault()} onClick={() => { onAsk(`Explain this passage from the attached source “${source.title}”:\n\n${passage.text.split("\n").map(line => `> ${line}`).join("\n")}`); setPassage(null); }}><Sparkles size={14} />Explain this passage</button>}
                  </> : <div className="article-unavailable" role="status"><FileText size={25} /><h3>The original is still one click away.</h3><p>{readingError || "Open the original source to read this page."}</p><button className="quiet-button" onClick={() => void window.eve.openSource(taskId, source.id).catch((error: Error) => setError(error.message))}>Open original <ArrowUpRight size={14} /></button></div>}
                </div>
              ) : (
                <div className="lesson-web-reference">
                  {source.assetId ? (
                    <FileText size={30} />
                  ) : (
                    <Link2 size={30} />
                  )}
                  <h2>
                    {source.assetId
                      ? "Material, kept close."
                      : "A useful connection."}
                  </h2>
                  <p>
                    {source.assetId
                      ? "This saved copy stays with your work. Open it as a read-only reference."
                      : "This saved link stays with your work. Open its source to read the original."}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="lesson-empty">
              <BookOpen size={28} />
              <h2>
                {lesson ? "Bring a little context closer." : "Opening your sources…"}
              </h2>
              <p>
                {lesson
                  ? "Find an article, or paste a link to read and watch alongside your work. YouTube videos play here and keep your place."
                  : "Your work stays close while we find the reference."}
              </p>
            </div>
          )}
        </div>
        <aside className="lesson-context">
          {sourceKind === "video" && <div className="source-video-search"><span className="eyebrow">FIND A VIDEO</span><h3>{initialQuery || "Something worth watching"}</h3><p>Search YouTube, then paste a video link below to watch here with your work beside it.</p><button className="quiet-button" onClick={() => void window.eve.openVideoSearch(taskId, initialQuery || query || "educational video").catch((error: Error) => setError(error.message))}>Search YouTube <ArrowUpRight size={14} /></button></div>}
          <form className="source-search" onSubmit={event => void search(event)}>
            <label htmlFor={`source-search-${taskId}`}>Find an article</label>
            <div><Search size={15} /><input id={`source-search-${taskId}`} value={query} onChange={event => setQuery(event.target.value)} maxLength={300} placeholder="What are you curious about?" /><button type="submit" disabled={searching || !query.trim()}>{searching ? "Finding…" : "Find"}</button></div>
            <small>Search Wikipedia · Open any public article with a link</small>
          </form>
          {results && <div className="source-search-results" aria-live="polite">
            {results.length ? results.map(result => <button key={result.url} disabled={busy} onClick={() => void saveSource(result.url, result.title)}><span>{result.title}</span><p>{result.excerpt}</p><small><Plus size={12} />Read alongside · {result.provider}</small></button>) : <p>No matching articles. Try another phrase or add a link.</p>}
          </div>}
          {adding && (
            <form
              className="source-form"
              onSubmit={(event) => void attach(event)}
            >
              <label>
                A name to remember (optional)
                <input
                  value={title}
                  maxLength={240}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What is this about?"
                />
              </label>
              <label>
                Source link
                <input
                  type="url"
                  value={url}
                  maxLength={4096}
                  required
                  pattern="https://.*"
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="Article or YouTube link: https://…"
                />
              </label>
              <div>
                <span>Save a reference alongside this work.</span>
                <button
                  className="primary-button"
                  disabled={busy || !url.trim()}
                >
                  {busy ? "Opening…" : "Bring it here"}
                </button>
              </div>
            </form>
          )}
          {lesson && lesson.sources.length > 1 && (
            <div
              className="source-choices"
              role="group"
              aria-label="Choose a source"
            >
              {lesson.sources.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={source?.id === item.id}
                  className={source?.id === item.id ? "active" : ""}
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.url && resolveYouTubeSource(item.url).supported ? <Play size={13} /> : <FileText size={13} />}
                  {item.title}
                </button>
              ))}
            </div>
          )}
          {source && (
            <>
              {reading ? <div className="lesson-notes"><div className="eyebrow">A SOURCE TO THINK WITH</div><p>Keep writing with this article beside you. Eve can use the text you opened as context when you ask for help.</p></div> : source.excerpt ? (
                <div className="lesson-notes">
                  <div className="eyebrow">
                    {source.provenance.kind === "timestamped-notes"
                      ? "STUDY NOTES · NOT A TRANSCRIPT"
                      : source.provenance.kind === "licensed-transcript"
                        ? "TRANSCRIPT EXCERPT"
                        : "SAVED REFERENCE"}
                  </div>
                  <p>{source.excerpt}</p>
                </div>
              ) : (
                <div className="lesson-notes">
                  <div className="eyebrow">CONNECTED TO YOUR WORK</div>
                  <p>
                    This reference is saved as a link. Its page has not been
                    read or summarized here.
                  </p>
                </div>
              )}
              <details className="lesson-provenance">
                <summary>
                  <Link2 size={13} />
                  About this source
                </summary>
                {reading ? <>
                  <p>Text read from {new URL(reading.url).hostname} at {new Date(reading.retrievedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. The link is saved with your work; this extracted text is kept for this session.</p>
                  <p>The publisher retains rights. This reader does not verify the article’s claims or grant redistribution permission.</p>
                </> : <><p>{source.provenance.attribution}</p><p>{source.provenance.rights}</p></>}
              </details>
            </>
          )}
        </aside>
      </div>
      {error && (
        <p className="overlay-message" role="alert">
          {error}
        </p>
      )}
      <div className="lesson-footer">
        <button className="quiet-button" onClick={onBack}>
          <ArrowLeft size={15} />
          Back to your work
        </button>
        {onTryCurve && (
          <button className="primary-button" onClick={onTryCurve}>
            <SlidersHorizontal size={15} />
            Try the curve
          </button>
        )}
      </div>
    </section>
  );
}
