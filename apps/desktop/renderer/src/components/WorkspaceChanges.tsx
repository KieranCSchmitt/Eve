import { useLayoutEffect, useRef, useState } from "react";
import type { IntentProposal } from "../../../shared/bridge";

type Files = NonNullable<IntentProposal["files"]>;

// Keep the presentation bounded even if a future producer fails its own checks.
// Refuse the entire preview instead of silently hiding any proposed passage.
export function canPreviewWorkspaceFiles(
  files: IntentProposal["files"],
): files is Files {
  if (!Array.isArray(files) || !files.length || files.length > 8) return false;
  let passages = 0;
  const paths = new Set<string>();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path.length ||
      file.path.length > 4096 ||
      paths.has(file.path) ||
      !Array.isArray(file.changes) ||
      !file.changes.length
    )
      return false;
    paths.add(file.path);
    passages += file.changes.length;
    if (passages > 8) return false;
    for (const change of file.changes) {
      if (
        !change ||
        typeof change.before !== "string" ||
        typeof change.after !== "string" ||
        change.before.length > 8000 ||
        change.after.length > 8000
      )
        return false;
      const positions = [
        change.startLine,
        change.startColumn,
        change.endLine,
        change.endColumn,
      ];
      if (
        positions.some(
          (position) => !Number.isSafeInteger(position) || position < 1,
        )
      )
        return false;
      if (
        change.endLine < change.startLine ||
        (change.endLine === change.startLine &&
          change.endColumn < change.startColumn)
      )
        return false;
    }
  }
  return true;
}

function Passage({
  text,
  side,
  label,
}: {
  text: string;
  side: "before" | "after";
  label: string;
}) {
  return (
    <section className={`workspace-passage-side is-${side}`} aria-label={label}>
      <span className="workspace-passage-label">
        {side === "before" ? "BEFORE" : "AFTER"}
      </span>
      {text.length ? (
        <pre tabIndex={0} aria-label={`${label} code`}>
          <code>{text}</code>
        </pre>
      ) : (
        <p className="workspace-empty-passage">
          {side === "before"
            ? "Empty · insertion point"
            : "Empty · passage removed"}
        </p>
      )}
    </section>
  );
}

export function WorkspaceChanges({ files }: { files: Files }) {
  const container = useRef<HTMLElement>(null);
  const [selectedPath, setSelectedPath] = useState(files[0].path);
  useLayoutEffect(() => {
    // This mounts only after an explicit Preview change gesture. Bring the
    // beginning of that review into view without moving keyboard focus.
    container.current?.scrollIntoView({ block: "start" });
  }, []);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const passages = files.reduce(
    (count, file) => count + file.changes.length,
    0,
  );
  return (
    <section
      ref={container}
      className="workspace-changes"
      aria-label="Changed passages"
    >
      <div className="workspace-changes-heading">
        <h4>Changed passages</h4>
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} · {passages}{" "}
          {passages === 1 ? "passage" : "passages"}
        </span>
      </div>
      <p className="workspace-changes-explanation">
        Only these passages change. The rest of each file stays as it is.
      </p>
      <div className="workspace-changes-layout">
        <nav className="workspace-file-list" aria-label="Files to change">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              aria-pressed={selected.path === file.path}
              onClick={() => setSelectedPath(file.path)}
            >
              <span>{file.path}</span>
              <small>
                {file.changes.length}{" "}
                {file.changes.length === 1 ? "passage" : "passages"}
              </small>
            </button>
          ))}
        </nav>
        <div className="workspace-file-passages" key={selected.path}>
          <h5>{selected.path}</h5>
          {selected.changes.map((change, index) => (
            <article
              className="workspace-passage"
              key={index}
              aria-label={`Passage ${index + 1} in ${selected.path}`}
            >
              <div className="workspace-passage-position">
                <span>Passage {index + 1}</span>
                <span>
                  Original range · L{change.startLine}:C{change.startColumn} – L
                  {change.endLine}:C{change.endColumn}
                </span>
              </div>
              <div className="workspace-passage-comparison">
                <Passage
                  text={change.before}
                  side="before"
                  label={`Before passage ${index + 1} in ${selected.path}`}
                />
                <Passage
                  text={change.after}
                  side="after"
                  label={`After passage ${index + 1} in ${selected.path}`}
                />
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
