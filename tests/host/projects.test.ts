import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CoreStore } from "@eve/core";
import {
  ALL_CAPABILITIES,
  type CoreSnapshot,
  type RegisterProjectInput,
} from "@eve/contracts";
import {
  HostProjects,
  type ProjectSelectionOptions,
} from "../../apps/desktop/host/projects";
import { MutationGate } from "../../apps/desktop/host/mutation-gate";
import {
  serializeOrbitConfig,
  DEFAULT_ORBIT_CONFIG,
} from "../../adapters/orbit/src/index";

let root: string,
  folder: string,
  core: CoreStore,
  projects: HostProjects,
  taskId: string;
let picker: () => Promise<string | null>,
  beforeRegistration: (() => Promise<void>) | undefined,
  afterRegistration: (() => Promise<void>) | undefined;
let submitted: RegisterProjectInput[],
  lookups: RegisterProjectInput[],
  snapshots: CoreSnapshot[],
  gate: MutationGate;
const auth = {
  actorId: "native-host",
  origin: "trusted-ui" as const,
  capabilities: [...ALL_CAPABILITIES],
};
const choice = (selectionId: string) => ({
  selectionId,
  adapter: "generic" as const,
  preview: { kind: "none" as const },
});
function makeService(maxSelections?: number) {
  const options: ProjectSelectionOptions = {
    core: async <T>(method: string, input?: unknown): Promise<T> => {
      if (method === "snapshot") return core.snapshot() as T;
      if (method === "lookup-project-registration") {
        lookups.push(structuredClone(input) as RegisterProjectInput);
        return core.lookupProjectRegistration(input, auth) as T;
      }
      if (method !== "register-project")
        throw new Error(`Unexpected core call: ${method}`);
      submitted.push(structuredClone(input) as RegisterProjectInput);
      await beforeRegistration?.();
      const result = core.registerProject(input, auth);
      await afterRegistration?.();
      return result as T;
    },
    pickDirectory: () => picker(),
    mutate: (operation) => gate.run(operation),
    publish: (snapshot) => {
      snapshots.push(snapshot);
    },
    maxSelections,
  };
  return new HostProjects(options);
}
function newSpace(title = "My project") {
  const result = core.dispatch(
    { type: "CreateTask", requestId: crypto.randomUUID(), title, kind: "note" },
    auth,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.snapshot.activeTaskId!;
}
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "eve-project-selection-")),
  );
  folder = path.join(root, "original-project");
  await mkdir(folder);
  core = new CoreStore({ dbPath: path.join(root, "eve.db"), seed: false });
  taskId = newSpace();
  gate = new MutationGate();
  picker = async () => folder;
  beforeRegistration = undefined;
  afterRegistration = undefined;
  submitted = [];
  lookups = [];
  snapshots = [];
  projects = makeService();
});
afterEach(async () => {
  core.close();
  await rm(root, { recursive: true, force: true });
});

it("binds the actual chosen folder to its space, preserving notes and never executing or copying files", async () => {
  const task = core.snapshot().tasks[0]!;
  expect(
    core.dispatch(
      {
        type: "UpdateNote",
        requestId: "authored",
        taskId,
        expectedEpoch: task.epoch,
        expectedRevision: 0,
        body: "An existing idea stays here.",
      },
      auth,
    ).ok,
  ).toBe(true);
  const script = '{"scripts":{"start":"touch marker-that-must-not-exist"}}';
  await writeFile(path.join(folder, "package.json"), script);
  const selection = await projects.chooseExisting(taskId);
  expect(selection).toMatchObject({
    taskId,
    canonicalRoot: folder,
    availableAdapters: ["generic"],
  });
  expect(core.snapshot().tasks[0]?.project).toBeNull();
  const result = await projects.register(choice(selection!.selectionId));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.project).toMatchObject({
    canonicalRoot: folder,
    verification: "verified",
    kind: "external",
    adapter: "generic",
    preview: { kind: "none" },
  });
  expect(result.snapshot.tasks[0]).toMatchObject({
    id: taskId,
    kind: "project",
    projectPath: folder,
    note: { body: "An existing idea stays here." },
    parameters: null,
  });
  expect(await readdir(folder)).toEqual(["package.json"]);
  expect(await readFile(path.join(folder, "package.json"), "utf8")).toBe(
    script,
  );
  expect((await readdir(root)).includes("project-trust")).toBe(false);
  expect(snapshots).toHaveLength(1);
});

it("cannot accept a renderer path or a second simultaneous choice over the selected token", async () => {
  const selection = await projects.chooseExisting(taskId);
  expect(() =>
    projects.register({
      ...choice(selection!.selectionId),
      canonicalRoot: "/different/path",
    } as never),
  ).toThrow();
  let resolve!: () => void;
  let entered!: () => void;
  const committed = new Promise<void>((done) => {
    entered = done;
  });
  afterRegistration = () =>
    new Promise<void>((done) => {
      resolve = done;
      entered();
    });
  const first = projects.register(choice(selection!.selectionId));
  expect(projects.register(choice(selection!.selectionId))).toBe(first);
  await expect(
    projects.register({
      ...choice(selection!.selectionId),
      preview: { kind: "static", entry: "index.html" },
    }),
  ).rejects.toThrow("settings you already submitted");
  // Wait for the real core commit before releasing its observed IPC boundary.
  await committed;
  expect(resolve).toBeTypeOf("function");
  resolve();
  expect((await first).ok).toBe(true);
  expect(submitted).toHaveLength(1);
});

it("reconciles an uncertain core reply with the exact request after the user changes spaces", async () => {
  const selection = await projects.chooseExisting(taskId);
  afterRegistration = async () => {
    afterRegistration = undefined;
    throw new Error("Lost reply after durable commit.");
  };
  await expect(
    projects.register(choice(selection!.selectionId)),
  ).rejects.toThrow("Lost reply");
  expect(() => projects.dismiss(selection!.selectionId)).toThrow(
    "still confirming whether this project was added",
  );
  const elsewhere = newSpace("Unrelated work");
  const retry = await projects.register(choice(selection!.selectionId));
  expect(retry).toMatchObject({ ok: true, idempotent: true });
  expect(submitted).toHaveLength(1);
  expect(lookups).toEqual([submitted[0]]);
  expect(core.snapshot().activeTaskId).toBe(elsewhere);
  expect(core.snapshot().tasks.filter((task) => task.project)).toHaveLength(1);
  expect(
    core.snapshot().tasks.find((task) => task.id === taskId)?.project
      ?.canonicalRoot,
  ).toBe(folder);
});

it("recovers a durable registration after its reply is lost even when its original folder has moved", async () => {
  await writeFile(path.join(folder, "original.txt"), "Preserve my work.");
  const selection = await projects.chooseExisting(taskId);
  afterRegistration = async () => {
    afterRegistration = undefined;
    throw new Error("Lost reply after durable commit.");
  };
  await expect(
    projects.register(choice(selection!.selectionId)),
  ).rejects.toThrow("Lost reply");
  const moved = folder + "-moved";
  await rename(folder, moved);
  const retry = await projects.register(choice(selection!.selectionId));
  expect(retry).toMatchObject({
    ok: true,
    idempotent: true,
    project: { canonicalRoot: folder },
  });
  expect(submitted).toHaveLength(1);
  expect(lookups).toEqual([submitted[0]]);
  expect(core.snapshot().tasks.filter((task) => task.project)).toHaveLength(1);
  expect(await readFile(path.join(moved, "original.txt"), "utf8")).toBe(
    "Preserve my work.",
  );
  expect(() => projects.dismiss(selection!.selectionId)).not.toThrow();
});

it("does not register a replacement when an uncertain request never committed", async () => {
  const selection = await projects.chooseExisting(taskId);
  beforeRegistration = async () => {
    beforeRegistration = undefined;
    throw new Error("IPC disconnected before commit.");
  };
  await expect(
    projects.register(choice(selection!.selectionId)),
  ).rejects.toThrow("before commit");
  expect(() => projects.dismiss(selection!.selectionId)).toThrow(
    "still confirming whether this project was added",
  );
  await rename(folder, folder + "-original");
  await mkdir(folder);
  await writeFile(path.join(folder, "replacement.txt"), "Not selected.");
  await expect(
    projects.register(choice(selection!.selectionId)),
  ).rejects.toThrow("replaced");
  expect(submitted).toHaveLength(1);
  expect(lookups).toEqual([submitted[0]]);
  expect(core.snapshot().tasks[0]?.project).toBeNull();
  expect(await readFile(path.join(folder, "replacement.txt"), "utf8")).toBe(
    "Not selected.",
  );
  expect(() => projects.dismiss(selection!.selectionId)).not.toThrow();
});

it("rechecks Orbit configuration when an uncertain request has no durable receipt", async () => {
  const file = path.join(folder, "eve.project.json");
  await writeFile(file, serializeOrbitConfig(DEFAULT_ORBIT_CONFIG));
  const selection = await projects.chooseExisting(taskId);
  const orbitChoice = {
    selectionId: selection!.selectionId,
    adapter: "orbit" as const,
    preview: { kind: "static" as const, entry: "index.html" },
  };
  beforeRegistration = async () => {
    beforeRegistration = undefined;
    throw new Error("IPC disconnected before commit.");
  };
  await expect(projects.register(orbitChoice)).rejects.toThrow("before commit");
  const changed = serializeOrbitConfig({
    ...DEFAULT_ORBIT_CONFIG,
    durationMinutes: 45,
  });
  await writeFile(file, changed);
  await expect(projects.register(orbitChoice)).rejects.toThrow(
    "configuration changed",
  );
  expect(submitted).toHaveLength(1);
  expect(lookups).toEqual([submitted[0]]);
  expect(core.snapshot().tasks[0]?.project).toBeNull();
  expect(await readFile(file, "utf8")).toBe(changed);
  expect(() => projects.dismiss(selection!.selectionId)).not.toThrow();
});

it("rejects a replaced folder before core registration", async () => {
  const selection = await projects.chooseExisting(taskId);
  await rename(folder, folder + "-original");
  await mkdir(folder);
  await expect(
    projects.register(choice(selection!.selectionId)),
  ).rejects.toThrow("replaced");
  expect(submitted).toEqual([]);
  expect(core.snapshot().tasks[0]?.project).toBeNull();
});

it("does not attach to another space when navigation occurs while the native picker is open", async () => {
  picker = async () => {
    newSpace("Another thought");
    return folder;
  };
  await expect(projects.chooseExisting(taskId)).rejects.toThrow(
    "space changed",
  );
  expect(core.snapshot().tasks.every((task) => !task.project)).toBe(true);
  expect(submitted).toEqual([]);
});

it("does not reuse a folder registered in another space", async () => {
  const selection = await projects.chooseExisting(taskId);
  expect((await projects.register(choice(selection!.selectionId))).ok).toBe(
    true,
  );
  taskId = newSpace("Another project");
  await expect(projects.chooseExisting(taskId)).rejects.toThrow(
    "already belongs",
  );
  expect(core.snapshot().tasks.filter((task) => task.project)).toHaveLength(1);
});

it("requires a fresh review when adapter configuration changes after selection", async () => {
  const file = path.join(folder, "eve.project.json");
  await writeFile(file, serializeOrbitConfig(DEFAULT_ORBIT_CONFIG));
  const selection = await projects.chooseExisting(taskId);
  expect(selection!.availableAdapters).toEqual(["generic", "orbit"]);
  await writeFile(
    file,
    serializeOrbitConfig({ ...DEFAULT_ORBIT_CONFIG, durationMinutes: 45 }),
  );
  await expect(
    projects.register({
      selectionId: selection!.selectionId,
      adapter: "orbit",
      preview: { kind: "static", entry: "index.html" },
    }),
  ).rejects.toThrow("configuration changed");
  expect(submitted).toEqual([]);
  expect(core.snapshot().tasks[0]?.project).toBeNull();
  expect((await projects.register(choice(selection!.selectionId))).ok).toBe(
    true,
  );
  expect(core.snapshot().tasks[0]?.parameters).toBeNull();
});

it("bounds pending selections and respects a held workspace mutation gate", async () => {
  projects = makeService(1);
  const selected = await projects.chooseExisting(taskId);
  await expect(projects.chooseExisting(taskId)).rejects.toThrow(
    "pending project selection",
  );
  const held = await gate.acquire();
  await expect(
    projects.register(choice(selected!.selectionId)),
  ).rejects.toThrow("backup");
  expect(submitted).toEqual([]);
  await held.release();
  projects.dismiss(selected!.selectionId);
  expect(await projects.chooseExisting(taskId)).not.toBeNull();
});
