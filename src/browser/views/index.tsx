/** Rebuilt pages: the view's kind picks the component. */
import type { BrowserView } from "../../browser-workspace.js";
import { ProjectsView } from "./projects-view.js";
import { ResultView } from "./result-view.js";
import { SettingsView } from "./settings-view.js";
import { TaskView, type ThreadChat } from "./task-view.js";
import { TasksView } from "./tasks-view.js";
import { FlowView } from "./flow-view.js";
import { AgentsView } from "./agents-view.js";

export { TaskDetails, type ThreadChat } from "./task-view.js";

/** `taskChat`: the task's conversation as thread entries and its composer; `taskDetails`: false when the shell shows Details beside the page. */
export function ViewHost({ view, csrf, taskChat = null, taskDetails = true }: { view: BrowserView; csrf: string; taskChat?: ThreadChat | null; taskDetails?: boolean }) {
  return <div data-view={view.kind} className="w-full">
    {view.kind === "tasks" ? <TasksView view={view} /> : view.kind === "settings" ? <SettingsView view={view} csrf={csrf} /> : view.kind === "task" ? <TaskView view={view} chat={taskChat} details={taskDetails} csrf={csrf} /> : view.kind === "projects" ? <ProjectsView view={view} csrf={csrf} /> : view.kind === "result" ? <ResultView view={view} csrf={csrf} /> : view.kind === "flow" ? <FlowView view={view} csrf={csrf} /> : view.kind === "agents" ? <AgentsView view={view} /> : null}
  </div>;
}
