import { describe, expect, it, vi } from "vitest";
import type {
  CoreSnapshot,
  SourceRecord,
} from "../../packages/contracts/src/index";
import type {
  MediaPlayerBridge,
  MediaCheckpoint,
} from "../../packages/media/src/index";
import type { CoreClient } from "../../apps/desktop/host/project-edits";

const mocks = vi.hoisted(() => ({ start: vi.fn(), app: { isPackaged: true } }));
vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("../../packages/media/src/index", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startMediaPlayer: mocks.start,
}));
import { TaskMedia } from "../../apps/desktop/host/media";
import { applicationReferer } from "../../packages/media/src/youtube";

const source: SourceRecord = {
  id: "lesson",
  taskId: "orbit",
  title: "Animation lesson",
  url: "https://www.youtube.com/watch?v=lVLzkleL_CE",
  excerpt: "",
  provenance: {
    kind: "web-source",
    attribution: "Chrome for Developers",
    rights: "Linked official player",
  },
  retrievedAt: 1,
  createdAt: 1,
};
const snapshot = {
  activeTaskId: "orbit",
  tasks: [{ id: "orbit", epoch: 0 }],
} as CoreSnapshot;
const core: CoreClient = async <T>(method: string): Promise<T> =>
  (method === "snapshot" ? snapshot : [source]) as T;
function player() {
  const checkpoint = {
    version: 1 as const,
    scope: { taskId: "orbit", taskEpoch: 0, generation: 1, sourceId: "lesson" },
    capturedAt: 1,
    snapshot: {
      videoId: "lVLzkleL_CE",
      currentTime: 18,
      duration: 293,
      playbackState: "paused" as const,
    },
  };
  return {
    connected: true,
    availability: "ready",
    checkpoint,
    send: vi.fn().mockResolvedValue(checkpoint),
    close: vi.fn().mockResolvedValue(undefined),
    url: "http://127.0.0.1:1234/player",
    referer: "https://org.eve.Shell",
  } as unknown as MediaPlayerBridge;
}

describe("host media context", () => {
  it.each([false, true])("uses the registered Linux desktop identity when packaged=%s", async (packaged) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    mocks.app.isPackaged = packaged;
    const bridge = player();
    mocks.start.mockResolvedValueOnce(bridge);
    const media = new TaskMedia(core);
    try {
      await expect(media.open("orbit", "lesson")).resolves.toBe(bridge);
      const options = mocks.start.mock.calls.at(-1)![0];
      expect(options).toMatchObject({ appId: "org.eve.Shell", source: { videoId: "lVLzkleL_CE" } });
      expect(applicationReferer(options.appId)).toBe("https://org.eve.shell/");
    } finally {
      await media.close();
      mocks.app.isPackaged = true;
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("admits only a fresh acknowledged pause from the chosen task/source", async () => {
    const bridge = player();
    mocks.start.mockResolvedValueOnce(bridge);
    const media = new TaskMedia(core);
    await media.open("orbit", "lesson");
    expect(
      await media.captureIntent("orbit", "different-source"),
    ).toBeUndefined();
    expect(await media.captureIntent("photo-walk")).toBeUndefined();
    expect(bridge.send).not.toHaveBeenCalled();
    expect(await media.captureIntent("orbit", "lesson")).toEqual({
      videoId: "lVLzkleL_CE",
      currentTime: 18,
      state: "paused",
    });
    expect(bridge.send).toHaveBeenCalledWith({ type: "capture", pause: true });
    await media.close();
  });
  it("keeps a durable recall position but never calls an unavailable checkpoint fresh context", async () => {
    const bridge = player();
    Object.assign(bridge, { availability: "unavailable", connected: false });
    mocks.start.mockResolvedValueOnce(bridge);
    const media = new TaskMedia(core);
    await media.open("orbit", "lesson");
    expect(await media.pauseAndCapture("orbit")).toMatchObject({
      currentTime: 18,
    });
    expect(await media.captureIntent("orbit", "lesson")).toBeUndefined();
    expect(bridge.send).not.toHaveBeenCalled();
    await media.close();
  });
  it("refuses an acknowledgement that still reports playback", async () => {
    const bridge = player();
    vi.mocked(bridge.send).mockResolvedValueOnce({
      ...bridge.checkpoint!,
      snapshot: { ...bridge.checkpoint!.snapshot, playbackState: "playing" },
    });
    mocks.start.mockResolvedValueOnce(bridge);
    const media = new TaskMedia(core);
    await media.open("orbit", "lesson");
    await expect(media.captureIntent("orbit")).rejects.toThrow(
      /Pause the video/,
    );
    await media.close();
  });
  it("does not accept an in-flight capture after its player has closed", async () => {
    const bridge = player();
    let resolve!: (value: MediaCheckpoint) => void;
    vi.mocked(bridge.send).mockImplementationOnce(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    mocks.start.mockResolvedValueOnce(bridge);
    const media = new TaskMedia(core);
    await media.open("orbit", "lesson");
    const capture = media.captureIntent("orbit");
    await media.close();
    resolve(bridge.checkpoint!);
    await expect(capture).rejects.toThrow(/video changed/);
    await expect(media.open("orbit", "lesson")).rejects.toThrow(/closed/);
  });
});
