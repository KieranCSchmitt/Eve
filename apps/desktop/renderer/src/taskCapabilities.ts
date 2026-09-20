import type { Activity, TaskRecord } from "@eve/contracts";

/** Presentation capabilities do not grant execution permission; the host does. */
export function taskCapabilities(task: TaskRecord | undefined) {
  const project = task?.kind === "project";
  const legacyOrbit = task?.project === undefined && task?.id === "orbit";
  const orbit = !!(
    project &&
    task?.parameters &&
    (task.project?.adapter === "orbit" || legacyOrbit)
  );
  const preview = !!(
    project &&
    (task?.project
      ? task.project.preview.kind !== "none"
      : legacyOrbit && task?.parameters)
  );
  const activities: Activity[] = ["notes", "video", "canvas"];
  if (project) activities.push("code");
  if (preview) activities.push("preview");
  if (orbit) activities.push("easing");
  const defaultActivity: Activity =
    task?.canvas?.document ? "canvas" : orbit && preview
      ? "preview"
      : project && task?.project?.verification === "verified"
        ? preview
          ? "preview"
          : "code"
        : "notes";
  return {
    project,
    orbit,
    preview,
    code: !!project,
    activities,
    defaultActivity,
  };
}

export function taskActivity(
  task: TaskRecord | undefined,
  requested?: Activity,
): Activity {
  const capabilities = taskCapabilities(task);
  return requested && capabilities.activities.includes(requested)
    ? requested
    : capabilities.defaultActivity;
}
