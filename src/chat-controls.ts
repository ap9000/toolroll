/** Fixed destinations only. A model cannot supply a URL or an executable action.
 * These open the existing authenticated controls, never grant their authority.
 */
export const CHAT_CONTROLS = {
  task: { label: "Open task", target: "task" },
  approval: { label: "Review & start", target: "task" },
  planning: { label: "Approve plan", target: "task" },
  recovery: { label: "Review recovery options", target: "task" },
  cancel: { label: "Cancel task", target: "task" },
  result: { label: "Open result", target: "task" },
  acceptance: { label: "Inspect result", target: "task" },
  publish: { label: "Review publication", target: "task" },
  projects: { label: "Manage projects", href: "/projects" },
  code: { label: "Open coding workspace", href: "/code" },
  flows: { label: "Open flows", href: "/flows" },
  recipes: { label: "Browse workflows", href: "/recipes" },
  workers: { label: "Manage workers", href: "/fleet" },
  slack: { label: "Manage Slack", href: "/settings/slack" },
  discord: { label: "Manage Discord", href: "/settings/discord" },
  // Settings → Lead: the lead's name and persona, changed there by its person.
  lead: { label: "Name your lead", href: "/settings/lead" },
  integrations: { label: "Set up integrations", href: "/settings/integrations" },
  settings: { label: "Open settings", href: "/settings" },
  permissions: { label: "Review permissions", href: "/settings" },
  providers: { label: "Connect an agent", href: "/settings#providers" },
  skills: { label: "Manage skills", href: "/settings/skills" },
  tools: { label: "Manage tools", href: "/settings/tools" },
  knowledge: { label: "Edit project knowledge", href: "/settings/knowledge" },
  learning: { label: "Review learning history", href: "/settings/learning" },
  mode: { label: "Review automatic approvals", href: "/mode" },
  // Sprint 8: allowed providers, models and tools, and the permission ceiling. Changed there, with a password.
  policy: { label: "Review organisation policy", href: "/settings/policy" },
} as const;
export type ChatControl = keyof typeof CHAT_CONTROLS;
export function isChatControl(value: unknown): value is ChatControl {
  return typeof value === "string" && Object.hasOwn(CHAT_CONTROLS, value);
}
/** The exact recorded result of one execution, opened where the console's
 * own result panel lives: the task lens names the execution, the run names
 * the result, and the tab names what to read first. Never the latest run. */
export type ChatResultTab = "summary" | "checks" | "changes";
export function chatResultHref(task: string, run: number, tab: ChatResultTab = "summary"): string {
  return `/chat?task=${encodeURIComponent(task)}&result=${run}${tab === "summary" ? "" : `&tab=${tab}`}`;
}
export function chatControlHref(control: ChatControl, task: string, run?: unknown, project?: unknown): string {
  const entry = CHAT_CONTROLS[control];
  if (control === "skills" || control === "tools") return CHAT_CONTROLS[control].href + (typeof project === "string" && project ? "?repo=" + encodeURIComponent(project) : "");
  if ("href" in entry) return entry.href;
  if (control === "acceptance") return `/review?result=${encodeURIComponent(task)}&run=${Number.isSafeInteger(run) && Number(run) > 0 ? run : 0}&tab=checks`;
  if (control === "result" && Number.isSafeInteger(run) && Number(run) > 0) return chatResultHref(task, Number(run));
  const base = "/chat?task=" + encodeURIComponent(task);
  // Task details owns cancel, retry, publication and other dedicated ceremonies.
  if (control === "cancel" || control === "recovery" || control === "publish") return "/t/" + encodeURIComponent(task);
  return base + (control === "approval" || control === "planning" ? "#task-chat-action" : "");
}
