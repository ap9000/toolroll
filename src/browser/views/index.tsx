/** Rebuilt pages: the view's kind picks the component. */
import type { BrowserView, BrowserWorkspace } from "../../browser-workspace.js";
import { ProjectsView } from "./projects-view.js";
import { ResultView } from "./result-view.js";
import { TaskView, type ResultSlot, type ThreadChat } from "./task-view.js";
import { SelectedResult } from "./result-view.js";

/** The task page's Result tab: the result view's own component, one per result run (its answers and drafts are that run's). */
const taskResult: ResultSlot = (selected, csrf, current) => <SelectedResult key={`${selected.taskId}:${selected.build ?? ""}`} selected={selected} csrf={csrf} inTask={{ current }} />;
import { TasksView } from "./tasks-view.js";
import { FlowView } from "./flow-view.js";
import { AgentsView } from "./agents-view.js";
import { HomeView } from "./home-view.js";
import { SearchView } from "./search-view.js";
import "../history.css";

export { TaskDetails, type ThreadChat } from "./task-view.js";

/** `taskChat`: the task's conversation as thread entries and its composer; `taskDetails`: false when the shell shows Details beside the page. */
export function ViewHost({ view, csrf, taskChat = null, taskDetails = true, workspace = null }: { view: BrowserView; csrf: string; taskChat?: ThreadChat | null; taskDetails?: boolean; workspace?: BrowserWorkspace | null }) {
  return <div data-view={view.kind} className="w-full">
    {view.kind === "tasks" ? <TasksView view={view} /> : view.kind === "task" ? <TaskView view={view} chat={taskChat} details={taskDetails} csrf={csrf} result={taskResult} /> : view.kind === "projects" ? <ProjectsView view={view} csrf={csrf} /> : view.kind === "result" ? <ResultView view={view} csrf={csrf} /> : view.kind === "flow" ? <FlowView view={view} csrf={csrf} /> : view.kind === "agents" ? <AgentsView view={view} /> : view.kind === "home" ? <HomeView view={view} /> : view.kind === "search" ? <SearchView view={view} workspace={workspace} /> : null}
  </div>;
}
