import { useEffect, useRef, useState } from "react";
import { ArrowRight, FolderOpen, ShieldCheck } from "lucide-react";
import { projectPreviewSchema, type TaskRecord } from "@eve/contracts";
import {
  projectSetupBusy,
  type ProjectChoice,
  type ProjectSetupState,
} from "../hooks/useProjectSetup";

export function ProjectSetup({
  task,
  state,
  onChoose,
  onSubmit,
  onCancel,
  onReview,
  onLater,
  onClose,
}: {
  task: TaskRecord;
  state?: ProjectSetupState;
  onChoose(): void;
  onSubmit(choice: ProjectChoice): void;
  onCancel(): void;
  onReview(): void;
  onLater(): void;
  onClose(): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const selection = state?.selection;
  const [adapter, setAdapter] = useState<"generic" | "orbit">("generic");
  const [previewKind, setPreviewKind] = useState<
    "none" | "static" | "loopback"
  >("none");
  const [entry, setEntry] = useState("index.html");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setAdapter("generic");
    setPreviewKind("none");
    setEntry("index.html");
    setUrl("");
    setError("");
    if (selection && document.activeElement === document.body)
      heading.current?.focus();
  }, [selection?.selectionId]);
  if (!state && !task.project) return null;
  if (!state && task.project)
    return (
      <section className="project-setup-connected" aria-label="Project setup">
        <span>
          <FolderOpen size={16} />
          Project attached
        </span>
        <div>
          <button className="quiet-button" onClick={onClose}>
            Close code and preview
          </button>
          <button className="quiet-button" onClick={onReview}>
            Review and open code
            <ArrowRight size={14} />
          </button>
        </div>
      </section>
    );
  const busy = projectSetupBusy(state);
  const choosing = state?.phase === "choosing";
  const review =
    selection &&
    state?.phase !== "attached" &&
    state?.phase !== "opening" &&
    state?.phase !== "closing";
  const frozen = busy || !!state?.submitted;
  const values = state?.submitted;
  const chosenAdapter = values?.adapter ?? adapter;
  const chosenPreview = values?.preview.kind ?? previewKind;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selection || busy) return;
    if (values) {
      onSubmit(values);
      return;
    }
    const preview =
      chosenPreview === "none"
        ? { kind: "none" as const }
        : chosenPreview === "static"
          ? { kind: "static" as const, entry: entry.trim() }
          : { kind: "loopback" as const, url: url.trim() };
    const parsed = projectPreviewSchema.safeParse(preview);
    if (!parsed.success) {
      setError(
        chosenPreview === "static"
          ? "Choose an HTML file inside this folder, such as index.html. Leave out a leading slash, .., or a link to another location."
          : "Enter a local server address such as http://127.0.0.1:3000/ or http://[::1]:3000/. Leave out passwords and any # ending.",
      );
      return;
    }
    if (!selection.availableAdapters.includes(chosenAdapter)) {
      setError("Choose one of the options available for this folder.");
      return;
    }
    setError("");
    onSubmit({
      selectionId: selection.selectionId,
      adapter: chosenAdapter,
      preview: parsed.data,
    });
  };
  return (
    <section
      className={`project-setup ${review ? "project-setup-review" : ""}`}
      aria-label="Project setup"
      aria-busy={busy}
    >
      <div className="project-setup-heading">
        <span className="project-setup-icon">
          <FolderOpen size={19} />
        </span>
        <div>
          <div className="eyebrow">
            {review
              ? "A FOLDER, CONNECTED TO THIS SPACE"
              : "ROOM TO MAKE SOMETHING"}
          </div>
          <h2 ref={heading} tabIndex={-1}>
            {choosing
              ? "Choose the project you want to bring here."
              : review
                ? selection.title
                : task.project
                  ? "Your project belongs with the thought."
                  : "Bring your project into this space."}
          </h2>
          <p>
            {choosing
              ? "The folder chooser is open."
              : review
                ? "Your files stay in their folder. Your note stays here."
                : "Keep the code and the ideas that shape it together."}
          </p>
        </div>
      </div>
      {review && (
        <form onSubmit={submit}>
          <div className="project-selected-folder">
            <span>Selected folder</span>
            <p>{selection.canonicalRoot}</p>
          </div>
          <fieldset disabled={frozen} className="project-setup-options">
            <legend>What this project can do</legend>
            <label className="project-adapter-option">
              <input
                type="radio"
                name={`adapter-${task.id}`}
                checked={chosenAdapter === "generic"}
                onChange={() => setAdapter("generic")}
              />
              <span>
                Code and notebook
                <small>
                  A coding workspace for this folder, alongside your notes.
                </small>
              </span>
            </label>
            {selection.availableAdapters.includes("orbit") && (
              <label className="project-adapter-option">
                <input
                  type="radio"
                  name={`adapter-${task.id}`}
                  checked={chosenAdapter === "orbit"}
                  onChange={() => setAdapter("orbit")}
                />
                <span>
                  Orbit controls
                  <small>
                    Add the study timer's color, duration and
                    movement controls.
                  </small>
                </span>
              </label>
            )}
            {selection.adapterIssue && (
              <p className="project-setup-detail">{selection.adapterIssue}</p>
            )}
            <details
              className="project-preview-options"
              open={chosenPreview !== "none" ? true : undefined}
            >
              <summary>
                Add a preview <span>Optional</span>
              </summary>
              <label htmlFor={`preview-kind-${task.id}`}>Preview source</label>
              <select
                id={`preview-kind-${task.id}`}
                value={chosenPreview}
                onChange={(event) => {
                  setPreviewKind(event.target.value as typeof previewKind);
                  setError("");
                }}
              >
                <option value="none">No preview</option>
                <option value="static">An HTML page in this folder</option>
                <option value="loopback">A local server I run</option>
              </select>
              {chosenPreview === "static" && (
                <>
                  <label htmlFor={`preview-entry-${task.id}`}>
                    HTML file in this folder
                  </label>
                  <input
                    id={`preview-entry-${task.id}`}
                    value={
                      values?.preview.kind === "static"
                        ? values.preview.entry
                        : entry
                    }
                    onChange={(event) => setEntry(event.target.value)}
                    placeholder="index.html"
                  />
                  <p className="project-setup-detail">
                    Choose a page such as index.html. Its images, scripts and
                    styles need links relative to that file. Build the page first
                    if your project requires a build step.
                  </p>
                </>
              )}
              {chosenPreview === "loopback" && (
                <>
                  <label htmlFor={`preview-url-${task.id}`}>
                    Local server address
                  </label>
                  <input
                    id={`preview-url-${task.id}`}
                    value={
                      values?.preview.kind === "loopback"
                        ? values.preview.url
                        : url
                    }
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="http://127.0.0.1:3000/"
                  />
                  <p className="project-setup-detail">
                    Start your project server first, then paste its address using
                    127.0.0.1 or [::1]. You’ll review the project before Eve opens
                    the preview.
                  </p>
                </>
              )}
            </details>
          </fieldset>
          {state.phase === "uncertain" && (
            <p className="project-setup-detail">
              Eve could not confirm that the folder was added. Retry will check
              the same folder and choices.
            </p>
          )}
          {(error || state.message) && (
            <p className="project-setup-message" role="alert">
              {error || state.message}
            </p>
          )}
          <div className="project-setup-actions">
            <button
              type="button"
              className="quiet-button"
              disabled={busy}
              onClick={onCancel}
            >
              {state.phase === "uncertain"
                ? "Check and cancel setup"
                : "Cancel setup"}
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
              {state.phase === "registering"
                ? "Attaching project…"
                : state.phase === "cancelling"
                  ? "Checking setup…"
                  : values
                    ? "Retry adding project"
                    : "Attach project"}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
      )}
      {!review && !choosing && (
        <>
          {state?.message && (
            <p className="project-setup-message" role="status">
              {state.message}
            </p>
          )}
          <div className="project-setup-actions">
            {task.project ||
            state?.phase === "attached" ||
            state?.phase === "opening" ||
            state?.phase === "closing" ? (
              <>
                <p className="project-setup-detail">
                  <ShieldCheck size={15} />
                  You decide when Eve can open and run this project.
                </p>
                {state?.phase === "attached" && (
                  <button className="quiet-button" onClick={onLater}>
                    Keep for later
                  </button>
                )}
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={onClose}
                >
                  {state?.phase === "closing"
                    ? "Closing code and preview…"
                    : "Close code and preview"}
                </button>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={onReview}
                >
                  {state?.phase === "opening"
                    ? "Reviewing project…"
                    : "Review and open code"}
                  <ArrowRight size={16} />
                </button>
              </>
            ) : (
              <>
                <button className="quiet-button" onClick={onCancel}>
                  Dismiss
                </button>
                <button className="primary-button" onClick={onChoose}>
                  Choose a folder
                  <FolderOpen size={16} />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
