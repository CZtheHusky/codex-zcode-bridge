import type { TaskFeedbackSnapshotV01 } from "../interfaces.js";

function displayText(value: string, limit: number): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, limit);
}

function oneLine(value: string, limit: number): string {
  return displayText(value.replace(/\s+/gu, " "), limit);
}

function truncatedOneLine(value: string, limit: number): string {
  const text = oneLine(value, limit + 1);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function testCommandLabel(value: string): string {
  let command = oneLine(value, 2_000);

  // Host shells often wrap the actual test command with environment setup.
  // Keep only the final command segment so HOME/TEMP assignments and wrapper
  // flags do not dominate the native transcript.
  const segments = command.split(/\s*&&\s*/u);
  if (segments.length > 1) command = segments.at(-1) ?? command;
  command = command.replace(/^['"]+|['"]+$/gu, "").trim();

  const dotnet = command.match(/\bdotnet\s+test\s+([^\s]+)(.*)$/iu);
  if (dotnet) {
    const project = (dotnet[1] ?? "").split(/[\\/]/u).at(-1)?.replace(/\.csproj$/iu, "") ?? "project";
    const filterTail = dotnet[2]?.match(/--filter(?:=|\s+)(.+)$/iu)?.[1]?.replace(/["']+$/gu, "").trim();
    const filter = filterTail?.includes("~") ? filterTail.slice(filterTail.lastIndexOf("~") + 1) : filterTail;
    return `dotnet test ${project}${filter ? ` · filter ${oneLine(filter, 64)}` : ""}`;
  }

  const packageScript = command.match(/\b(npm|pnpm|yarn)\s+(?:(run)\s+)?([A-Za-z0-9:_-]+)\b/iu);
  if (packageScript) {
    return `${packageScript[1]} ${packageScript[2] ? "run " : ""}${packageScript[3]}`;
  }

  // Unknown commands are represented by their executable and first operand;
  // avoid echoing arbitrary shell arguments into the user-facing renderer.
  const tokens = command.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/gu) ?? [];
  return tokens.slice(0, 2).map((token) => token.replace(/^['"]|['"]$/gu, "")).join(" ").slice(0, 96);
}

/** Render the v0.1 snapshot as concise native transcript text. */
export function renderTaskFeedback(snapshot: TaskFeedbackSnapshotV01): string {
  const terminalLabel = snapshot.status === "waiting_for_master"
    ? "WAITING_FOR_MASTER"
    : ["completed", "failed", "cancelled"].includes(snapshot.status)
      ? snapshot.status.toUpperCase()
      : null;
  const lines = [`▣ ZCode · ${snapshot.task_id}${terminalLabel ? ` · ${terminalLabel}` : ""}`];

  switch (snapshot.status) {
    case "queued":
      lines.push("○ Queued");
      break;
    case "running":
      lines.push("→ Running");
      if (snapshot.model) {
        const modelId = oneLine(snapshot.model.model_id ?? "", 160);
        const reasoning = snapshot.model.reasoning_level ? oneLine(snapshot.model.reasoning_level, 80) : "";
        if (modelId) lines.push(`Model: ${modelId}${reasoning ? ` · Reasoning: ${reasoning}` : ""}`);
      }
      if (snapshot.activity) lines.push("", `Last observed: ${oneLine(snapshot.activity.summary, 160)}`);
      break;
    case "completed":
      lines.push("✓ Bridge task completed");
      break;
    case "failed":
      lines.push("✗ Bridge task failed");
      break;
    case "cancelled":
      lines.push("Result: Task cancellation confirmed by Bridge");
      break;
    case "waiting_for_master":
      lines.push("Agent report requires a master decision.");
      break;
  }

  const result = snapshot.result;
  if (result) {
    lines.push("", "Agent report:");
    const summary = truncatedOneLine(result.summary, 220);
    if (summary) lines.push(summary);
    const changedCount = result.files_changed.length;
    lines.push(`Changed: ${changedCount} ${changedCount === 1 ? "file" : "files"}`);
    for (const test of result.tests.slice(0, 3)) {
      lines.push(`Tests: ${testCommandLabel(test.command)} · reported ${test.status}`);
    }
    if (result.tests.length > 3) lines.push(`Tests: ${result.tests.length - 3} more reported`);
    if (result.issues.length) {
      const issue = truncatedOneLine(result.issues[0] ?? "", 140);
      lines.push(`! ${result.issues.length} reported ${result.issues.length === 1 ? "issue" : "issues"}${issue ? ` · ${issue}` : ""}`);
      if (result.issues.length > 1) lines.push(`! ${result.issues.length - 1} more reported issues`);
    }
    if (result.duration_ms !== null) lines.push(`Duration: ${formatDuration(result.duration_ms)}`);
  }

  return lines.join("\n");
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}
