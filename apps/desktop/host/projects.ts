import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  projectPreviewSchema,
  type CoreSnapshot,
  type ProjectPreview,
  type ProjectRegistrationResult,
  type RegisterProjectInput,
  type CoreValueResult,
  type ProjectRecord,
} from "@eve/contracts";
import {
  registerProjectFolder,
  type ProjectRegistration as ImportedProject,
} from "../../../packages/imports/src/index";
import { inspectProjectDirectory } from "./project-trust";
import type { CoreClient } from "./project-edits";

export interface ProjectSelection {
  readonly selectionId: string;
  readonly taskId: string;
  readonly title: string;
  readonly canonicalRoot: string;
  readonly availableAdapters: readonly ("generic" | "orbit")[];
  readonly adapterIssue?: string;
}
export interface ProjectSelectionOptions {
  core: CoreClient;
  /** A host native directory chooser. Never take a path from renderer/model input. */
  pickDirectory(): Promise<string | null>;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  /** Delivers the acknowledged canonical state; must not throw or steal focus. */
  publish(snapshot: CoreSnapshot): void;
  maxSelections?: number;
}
interface Selection {
  public: ProjectSelection;
  imported: ImportedProject;
  identity: Awaited<ReturnType<typeof inspectProjectDirectory>>;
  epoch: number;
  taskRevision: number;
  requestId: string;
  input?: RegisterProjectInput;
  choice?: string;
  inFlight?: Promise<ProjectRegistrationResult>;
  completed: boolean;
  uncertain: boolean;
}
const choiceSchema = z
  .object({
    selectionId: z.string().uuid(),
    adapter: z.enum(["generic", "orbit"]),
    preview: projectPreviewSchema,
  })
  .strict();

/** Selection/registration only. This never starts an editor, grants trust,
 * installs dependencies, copies an external folder, or runs project code. */
export class HostProjects {
  private readonly selections = new Map<string, Selection>();
  private choosing = false;
  private readonly maxSelections: number;
  constructor(private readonly options: ProjectSelectionOptions) {
    this.maxSelections = options.maxSelections ?? 16;
    if (
      !Number.isInteger(this.maxSelections) ||
      this.maxSelections < 1 ||
      this.maxSelections > 64
    )
      throw new Error("Project selections need a bounded capacity.");
  }
  async chooseExisting(taskId: string): Promise<ProjectSelection | null> {
    if (this.choosing)
      throw new Error("Finish the current folder selection first.");
    // Completed receipts may leave memory; incomplete/uncertain registrations
    // retain their exact request identity and are never evicted to make room.
    for (const [id, selection] of this.selections) {
      if (this.selections.size < this.maxSelections) break;
      if (selection.completed) this.selections.delete(id);
    }
    if (this.selections.size >= this.maxSelections)
      throw new Error(
        "Finish or dismiss a pending project selection before choosing another folder.",
      );
    this.choosing = true;
    try {
      const before = await this.options.core<CoreSnapshot>("snapshot");
      const task = before.tasks.find((task) => task.id === taskId);
      if (!task || before.activeTaskId !== taskId)
        throw new Error("Choose a folder from the space you want to use.");
      if (task.project)
        throw new Error(
          "This space already has a project. Its files and editor were preserved.",
        );
      const selected = await this.options.pickDirectory();
      if (!selected) return null;
      const identity = await inspectProjectDirectory(selected);
      const imported = await registerProjectFolder({
        sourcePath: identity.canonicalRoot,
      });
      const checked = await inspectProjectDirectory(identity.canonicalRoot);
      if (JSON.stringify(identity) !== JSON.stringify(checked))
        throw new Error("The selected folder changed. Choose it again.");
      const current = await this.options.core<CoreSnapshot>("snapshot");
      const target = current.tasks.find((item) => item.id === taskId);
      if (
        current.activeTaskId !== taskId ||
        !target ||
        target.epoch !== task.epoch ||
        target.revision !== task.revision ||
        target.project
      )
        throw new Error(
          "The space changed while the folder chooser was open. Choose the folder again in the intended space.",
        );
      const duplicate = current.tasks.find(
        (item) =>
          item.project &&
          (item.project.canonicalRoot === identity.canonicalRoot ||
            (item.project.rootIdentity?.device ===
              identity.rootIdentity.device &&
              item.project.rootIdentity.inode === identity.rootIdentity.inode)),
      );
      if (duplicate)
        throw new Error(
          `This folder already belongs to “${duplicate.title}”. Open that space to continue editing.`,
        );
      const publicSelection: ProjectSelection = Object.freeze({
        selectionId: randomUUID(),
        taskId,
        title: imported.title,
        canonicalRoot: identity.canonicalRoot,
        availableAdapters: Object.freeze(
          imported.adapter
            ? (["generic", "orbit"] as const)
            : (["generic"] as const),
        ),
        ...(imported.adapterIssue
          ? { adapterIssue: imported.adapterIssue }
          : {}),
      });
      this.selections.set(publicSelection.selectionId, {
        public: publicSelection,
        imported,
        identity,
        epoch: task.epoch,
        taskRevision: task.revision,
        requestId: randomUUID(),
        completed: false,
        uncertain: false,
      });
      return publicSelection;
    } finally {
      this.choosing = false;
    }
  }

  dismiss(selectionId: string): void {
    const selection = this.selections.get(selectionId);
    if (!selection) return;
    if (selection.inFlight || selection.uncertain)
      throw new Error(
        "Eve is still confirming whether this project was added. Retry before dismissing the result.",
      );
    this.selections.delete(selectionId);
  }

  register(input: {
    selectionId: string;
    adapter: "generic" | "orbit";
    preview: ProjectPreview;
  }): Promise<ProjectRegistrationResult> {
    const choice = choiceSchema.parse(input);
    const selection = this.selections.get(choice.selectionId);
    if (!selection)
      return Promise.reject(
        new Error(
          "This folder selection is no longer available. Choose the folder again.",
        ),
      );
    const choiceKey = JSON.stringify(choice);
    if (selection.choice && selection.choice !== choiceKey)
      return Promise.reject(
        new Error(
          "Eve is still confirming the project settings you already submitted. Check the result before changing them.",
        ),
      );
    if (selection.inFlight) return selection.inFlight;
    selection.choice = choiceKey;
    const operation = this.options.mutate(async () => {
      if (selection.input) {
        const prior = await this.options.core<
          CoreValueResult<{
            project: ProjectRecord;
            snapshot: CoreSnapshot;
          } | null>
        >("lookup-project-registration", selection.input);
        if (!prior.ok) return prior;
        selection.uncertain = false;
        if (prior.value) {
          selection.completed = true;
          try {
            this.options.publish(prior.value.snapshot);
          } catch {
            /* A presentation error cannot revoke the durable outcome. */
          }
          return { ok: true, ...prior.value, idempotent: true } as const;
        }
      }
      const identity = await inspectProjectDirectory(
        selection.identity.canonicalRoot,
      );
      if (JSON.stringify(identity) !== JSON.stringify(selection.identity))
        throw new Error(
          "The selected folder was replaced before it could be added. Choose its current folder and try again.",
        );
      const imported = await registerProjectFolder({
        sourcePath: identity.canonicalRoot,
      });
      if (
        choice.adapter === "orbit" &&
        (!imported.adapter ||
          imported.adapter.configSha256 !==
            selection.imported.adapter?.configSha256)
      )
        throw new Error(
          "The Orbit configuration changed since selection. Choose the folder again before enabling its controls.",
        );
      const checked = await inspectProjectDirectory(identity.canonicalRoot);
      if (JSON.stringify(checked) !== JSON.stringify(identity))
        throw new Error("The selected folder changed during inspection.");
      if (!selection.input) {
        const project: RegisterProjectInput["project"] = {
          id: selection.imported.id,
          canonicalRoot: identity.canonicalRoot,
          rootIdentity: identity.rootIdentity,
          kind: "external",
          adapter: choice.adapter,
          preview: choice.preview,
        };
        const config =
          choice.adapter === "orbit" ? imported.adapter!.config : undefined;
        selection.input = {
          requestId: selection.requestId,
          taskId: selection.public.taskId,
          expectedEpoch: selection.epoch,
          expectedTaskRevision: selection.taskRevision,
          project,
          ...(config
            ? {
                parameters: {
                  theme: config.theme,
                  durationMinutes: config.durationMinutes,
                  transitionMs: config.transitionMs,
                  easing: config.easing,
                },
              }
            : {}),
        };
        selection.choice = choiceKey;
      }
      // Retry preserves the original request/epoch/metadata. An uncertain IPC
      // reply must never create a second project or bind to the new active task.
      selection.uncertain = true;
      const result = await this.options.core<ProjectRegistrationResult>(
        "register-project",
        selection.input,
      );
      if (result.ok) {
        selection.completed = true;
        selection.uncertain = false;
      } else if (result.error.code !== "STORAGE_ERROR") {
        selection.uncertain = false;
        selection.input = undefined;
        selection.choice = undefined;
      }
      try {
        this.options.publish(result.snapshot);
      } catch {
        /* An observer cannot revoke an acknowledged registration. */
      }
      return result;
    });
    selection.inFlight = operation;
    void operation
      .finally(() => {
        if (selection.inFlight === operation) {
          selection.inFlight = undefined;
          if (!selection.input) selection.choice = undefined;
        }
      })
      .catch(() => {});
    return operation;
  }
}
