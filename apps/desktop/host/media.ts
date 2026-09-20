import path from "node:path";
import { readFile } from "node:fs/promises";
import { app } from "electron";
import {
  CHROME_ANIMATION_LESSON,
  ORBIT_LESSON_NOTES,
  registerAuthoredNote,
  resolveYouTubeSource,
  startMediaPlayer,
  toCoreMediaContext,
  type MediaPlayerBridge,
} from "../../../packages/media/src/index";
import { normalizeWebSource } from "../../../packages/imports/src/index";
import { readWebArticle, searchWikipedia, type ArticleReading } from "../../../packages/imports/src/web-reader";
import type {
  CoreSnapshot,
  SourceRecord,
  CoreValueResult,
  ContextSnapshot,
} from "@eve/contracts";
import type { CoreClient } from "./project-edits";
import type { LessonState } from "../shared/bridge";

/** Owns only the player and source context; it never grants a source permission to execute Eve actions. */
export class TaskMedia {
  player?: MediaPlayerBridge;
  private taskId?: string;
  private epoch?: number;
  private sourceId?: string;
  private generation = 0;
  private closed = false;
  private opening?: Promise<MediaPlayerBridge>;
  private readings = new Map<string, ArticleReading>();
  private readingRequests = new Map<string, Promise<ArticleReading>>();
  constructor(private core: CoreClient) {}
  async seed() {
    const sources = await this.core<SourceRecord[]>("list-sources", "orbit");
    if (sources.some((source) => source.id === ORBIT_LESSON_NOTES[0]!.id))
      return;
    const resolved = resolveYouTubeSource(CHROME_ANIMATION_LESSON.url);
    if (!resolved.supported) throw new Error(resolved.reason);
    const registration = registerAuthoredNote({
      note: ORBIT_LESSON_NOTES[0]!,
      source: resolved.source,
      taskId: "orbit",
      lessonTitle: CHROME_ANIMATION_LESSON.title,
    });
    const result = await this.core<CoreValueResult<SourceRecord>>(
      "register-source",
      registration,
    );
    if (!result.ok) throw new Error(result.error.message);
  }
  async list(taskId: string): Promise<SourceRecord[]> {
    return this.core("list-sources", taskId);
  }
  async attach(taskId: string, url: string, title: string) {
    await this.attachOne(taskId, url, title);
    return this.list(taskId);
  }
  async attachOne(taskId: string, url: string, title: string): Promise<SourceRecord> {
    const source = normalizeWebSource({
      taskId,
      url,
      title,
      attachedAt: Date.now(),
    });
    const existing = (await this.list(taskId)).find(item => item.url === source.url);
    if (existing) return existing;
    const result = await this.core<CoreValueResult<SourceRecord>>(
      "register-source",
      source,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  async read(taskId: string, sourceId: string): Promise<ArticleReading> {
    const source = (await this.list(taskId)).find(item => item.id === sourceId);
    if (!source?.url || source.assetId || resolveYouTubeSource(source.url).supported) throw new Error("Choose an attached article to read.");
    const key = `${taskId}:${sourceId}`;
    const cached = this.readings.get(key);
    if (cached) return cached;
    const pending = this.readingRequests.get(key);
    if (pending) return pending;
    const reading = readWebArticle(source.url).then(value => {
      if (!this.closed) {
        // Bound memory; cached text is session material, never presented as a durable saved copy.
        if (this.readings.size >= 24) this.readings.delete(this.readings.keys().next().value!);
        this.readings.set(key, value);
      }
      return value;
    }).finally(() => this.readingRequests.delete(key));
    this.readingRequests.set(key, reading);
    return reading;
  }
  async contextSources(taskId: string): Promise<SourceRecord[]> {
    return (await this.list(taskId)).map(source => {
      const reading = this.readings.get(`${taskId}:${source.id}`);
      return !reading ? source : { ...source, excerpt: reading.text, retrievedAt: reading.retrievedAt,
        provenance: { kind: "web-source" as const, sourceUrl: reading.url,
          attribution: `Page text retrieved from ${new URL(reading.url).hostname} for this session. ${reading.truncated ? "Text is truncated. " : ""}This is extracted source text, not a generated summary.`,
          rights: "The publisher retains rights. Reading a public page does not grant redistribution permission." } };
    });
  }
  async search(query: string) {
    return searchWikipedia(query);
  }
  async status(taskId: string): Promise<LessonState> {
    const sources = await this.list(taskId);
    return {
      sources,
      sourceId: this.taskId === taskId ? (this.sourceId ?? null) : null,
      availability:
        this.taskId === taskId
          ? (this.player?.availability ?? "not-open")
          : "not-open",
      checkpoint:
        this.taskId === taskId ? (this.player?.checkpoint ?? null) : null,
    };
  }
  open(taskId: string, sourceId?: string): Promise<MediaPlayerBridge> {
    if (this.closed)
      return Promise.reject(new Error("The media service is closed."));
    const pending = (
      this.opening?.catch(() => undefined) ?? Promise.resolve()
    ).then(() => this.openOnce(taskId, sourceId));
    this.opening = pending;
    void pending.then(
      () => {
        if (this.opening === pending) this.opening = undefined;
      },
      () => {
        if (this.opening === pending) this.opening = undefined;
      },
    );
    return pending;
  }
  private async openOnce(taskId: string, sourceId?: string) {
    if (this.closed) throw new Error("The video player is closed. Reopen the source to continue.");
    const snapshot = await this.core<CoreSnapshot>("snapshot");
    const task = snapshot.tasks.find((task) => task.id === taskId);
    if (!task || snapshot.activeTaskId !== taskId)
      throw new Error("Return to this space before opening its video.");
    const sources = await this.list(taskId);
    const source = sourceId
      ? sources.find((source) => source.id === sourceId)
      : sources.find(
          (source) => source.url && resolveYouTubeSource(source.url).supported,
        );
    if (!source?.url)
      throw new Error("Add a supported YouTube link to this space.");
    const resolved = resolveYouTubeSource(source.url);
    if (!resolved.supported) throw new Error(resolved.reason);
    if (
      this.taskId === taskId &&
      this.epoch === task.epoch &&
      this.sourceId === source.id &&
      this.player
    )
      return this.player;
    await this.player?.close();
    this.player = undefined;
    const appId = await this.applicationId();
    const scope = {
      taskId,
      taskEpoch: task.epoch,
      generation: ++this.generation,
      sourceId: source.id,
    };
    const saved = task.checkpoint?.media;
    this.player = await startMediaPlayer({
      source: resolved.source,
      scope,
      title: source.title,
      appId,
      ...(saved?.videoId === resolved.source.videoId
        ? {
            checkpoint: {
              version: 1 as const,
              scope,
              capturedAt: task.checkpoint?.updatedAt ?? 0,
              snapshot: {
                videoId: saved.videoId,
                currentTime: saved.currentTime,
                duration: 0,
                playbackState: "paused" as const,
              },
            },
          }
        : {}),
    });
    this.taskId = taskId;
    this.epoch = task.epoch;
    this.sourceId = source.id;
    return this.player;
  }
  async pauseAndCapture(taskId: string): Promise<ContextSnapshot["media"]> {
    if (this.taskId !== taskId || !this.player) return undefined;
    if (this.player.connected && this.player.availability === "ready") {
      const checkpoint = await this.player.send({
        type: "capture",
        pause: true,
      });
      return toCoreMediaContext(checkpoint.snapshot) ?? undefined;
    }
    return this.player.checkpoint
      ? (toCoreMediaContext(this.player.checkpoint.snapshot) ?? undefined)
      : undefined;
  }
  /** Intent context requires a fresh player acknowledgement, never the durable recall fallback. */
  async captureIntent(
    taskId: string,
    sourceId?: string,
  ): Promise<ContextSnapshot["media"]> {
    const player = this.player;
    const generation = this.generation;
    if (
      this.taskId !== taskId ||
      !player ||
      (sourceId && sourceId !== this.sourceId)
    )
      return undefined;
    if (!player.connected || player.availability !== "ready") return undefined;
    const checkpoint = await player.send({ type: "capture", pause: true });
    if (
      this.player !== player ||
      this.generation !== generation ||
      this.taskId !== taskId
    )
      throw new Error(
        "The video changed while Eve saved your place. Ask again from the current source.",
      );
    const context = toCoreMediaContext(checkpoint.snapshot);
    if (!context || context.state === "playing")
      throw new Error(
        "Pause the video before asking about its current moment.",
      );
    return context;
  }
  private async applicationId() {
    // The Linux host sets org.eve.Shell.desktop before ready, including source
    // launches. Packaging is not the identity boundary: use that same desktop
    // application ID for the official player's HTTPS Referer/widget_referrer.
    if (app.isPackaged || process.platform === "linux") return "org.eve.Shell";
    if (process.platform === "darwin") {
      const plist = await readFile(
        path.resolve(process.execPath, "../../Info.plist"),
        "utf8",
      );
      const identifier =
        /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(
          plist,
        )?.[1];
      if (identifier) return identifier;
    }
    throw new Error(
      "Video playback is unavailable in this version of Eve. Your saved sources and notes are still available.",
    );
  }
  async close() {
    this.closed = true;
    this.readings.clear();
    await this.opening?.catch(() => undefined);
    await this.player?.close();
    this.player = undefined;
  }
}
