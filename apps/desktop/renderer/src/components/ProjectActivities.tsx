import { Code2, FileText, Play } from "lucide-react";
import type { Activity, TaskRecord } from "@eve/contracts";
import { taskCapabilities } from "../taskCapabilities";

export function ProjectActivities({
  task,
  activity,
  onChange,
}: {
  task: TaskRecord;
  activity: Activity;
  onChange(activity: Activity): void;
}) {
  const capabilities = taskCapabilities(task);
  return (
    <div
      className="segmented project-activities"
      role="group"
      aria-label="Project activities"
    >
      {capabilities.preview && (
        <button
          type="button"
          aria-pressed={activity === "preview"}
          className={activity === "preview" ? "active" : ""}
          onClick={() => onChange("preview")}
        >
          <Play size={13} />
          Preview
        </button>
      )}
      {capabilities.code && (
        <button
          type="button"
          aria-pressed={activity === "code"}
          className={activity === "code" ? "active" : ""}
          onClick={() => onChange("code")}
        >
          <Code2 size={15} />
          Code
        </button>
      )}
      <button
        type="button"
        aria-pressed={activity === "notes"}
        className={activity === "notes" ? "active" : ""}
        onClick={() => onChange("notes")}
      >
        <FileText size={14} />
        Notebook
      </button>
    </div>
  );
}
