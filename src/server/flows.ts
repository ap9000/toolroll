import { handlersOf } from './handler-registry.js';
/** flows handlers, moved without changing their route bodies. */
import { createHash } from "node:crypto";
import { type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentAuthority } from "../agentconfig.js";
import { checkResponse,CONSOLE_FORMS,readForm } from "../contracts/console-api.js";
import { stageReferenceProblems } from "../contracts/stage-output.js";
import { LIMITS } from "../decision.js";
import { run as execRun } from "../exec.js";
import { setFlowSecret } from "../flow-actions.js";
import { addCardToFlow,advanceFlows,cancelFlowCard,crossProjectProblem,decideFlowCard,flowDefinitionOf,moveCardInFlow } from "../flow-engine.js";
import { galleryHtml,galleryUseHtml } from "../flow-gallery-ui.js";
import { galleryDefaults,galleryDiagram,galleryTemplateOf,galleryToolsOf,previewGallery,useGalleryTemplate,type GalleryAnswers,type GalleryPreview } from "../flow-gallery.js";
import { flowInsights } from "../flow-insights.js";
import { assignFlowCard,commentOnFlowCard,watchFlowCard } from "../flow-people.js";
import { saveScript } from "../flow-scripts.js";
import { chooseFlowCard } from "../flow-send.js";
import { exportFlow,fetchFlowFile,FlowFileError,importFlow,parseFlowFile,planFlowImport,type FlowImportPlan } from "../flow-share.js";
import { addFlowTriggerTo,checkFlowTriggerNow,pressFlowButton,removeFlowTrigger,removeLinearKey,setFlowTriggerOn,renewFlowHook,saveHooksBase,saveLinearKey,saveLinearSigningSecret,shareFlowButton,stopSharingFlowButton } from "../flow-triggers.js";
import { FLOW_IMPORT_SCRIPT,flowFallbackHtml,flowImportHtml,flowsListHtml,flowView } from "../flows-ui.js";
import { FLOW_TEMPLATES,FlowContractError,validateFlowDefinition,withZoneNames } from "../flows.js";
import { keyStatus } from "../keys.js";
import { kitPageHtml,kitsGalleryHtml } from "../kits-ui.js";
import { addKitGithubTrigger,addKitSample,kitOf,setUpKit } from "../kits.js";
import { connectionsOf } from "../mcp-connect.js";
import {
authorizedProject,
projectName,
rowVisible
} from "../project.js";
import { recipeAnswersFromForm,recipeDefinitionPreviewHtml,recipeEditorHtml,recipeFromForm,recipeLibraryHtml,recipeRunHtml,recipeScript,workflowPreviewHtml } from "../recipe-ui.js";
import { createWorkflowPreview,exportRecipe,findRecipe,importRecipe,launchWorkflow,prepareRecipeRun,RecipeError,savedRecipes,saveWorkflowRecipe,starterRecipes,workflowPreview } from "../recipes.js";
import { isAlive as runnerAlive } from "../runner.js";
import { createSubagentFrom,labelOf,nameOf,saveSoul,sendSubagentSummaries,setSubagentState,subagentSettings } from "../subagent-admin.js";
import { addRoutine,removeRoutine,runRoutine } from "../subagent-desk.js";
import { editMemory,forgetMemory,tellSubagent } from "../subagent-memory.js";
import { grantTool,revokeTool,rulesFromForm,setToolRules } from "../subagent-tools.js";
import { sendSubagentWeeklies,undoCall } from "../subagent-week.js";
import { answerSubagentQuestion } from "../subagent-work.js";
import { BLANK_SOUL,subagentPageHtml,subagentsListHtml } from "../subagents-ui.js";
import type { HandlerContext } from './handler-context.js';
import type { ServerRuntime } from './runtime.js';
import { requestContext } from "./request-context.js";
import { refuse,screen } from "./chrome.js";
import { redirect,respond,SAFETY,taskHref } from "./http.js";
import { html, type Html } from "../html.js";
import { type Who } from "./session.js";
export function createFlowsHandlers(runtime: ServerRuntime) {
  const { store, clock, sendScreen, chromeFor, consoleProjects, options, visible, flowRooms, identify, liveCeiling, providerHome, toolHome, restricted, evidenceRoot, authenticateApprover, projectOf, unscopedMode, ceiling, authorizeMutation } = runtime;

  // ---- reads ---------------------------------------------------------------

  /** A gallery template's page (Flows → New → Use this): its questions, the preview of these answers, and Create. */
  function sendGalleryUse(response: ServerResponse, who: Who, template: NonNullable<ReturnType<typeof galleryTemplateOf>>, projects: readonly string[], repo: string, given: GalleryAnswers | null, name: string, notice: string | null, said: string | null = null): void {
    const answers = given ?? galleryDefaults(store, template, repo);
    let preview: GalleryPreview | null = null, problem = notice;
    try { preview = previewGallery(store, template, repo, answers, who.name, clock()); }
    catch (error) { problem = error instanceof Error ? error.message : "That can't be made here."; }
    const diagram = preview?.built.definition ?? galleryDiagram(template);
    const page = galleryUseHtml({ template, projects: projects.map(path => ({ path, name: projectName(path) })), repo, answers, name, preview, problem,
      csrf: who.via === "cookie" ? who.session.csrf : "", diagram, tools: preview?.tools ?? galleryToolsOf(template, diagram, connectionsOf(store, repo)), said });
    return sendScreen(response, problem !== null && preview === null && notice !== null ? 400 : 200, screen(template.name, html`<p><a href="/flows/new">New flow</a></p><h1>${template.name}</h1>${page}`, { chrome: chromeFor(repo, "flows") }));
  }
  // ---- path parameters and shared lookups ------------------------------------

  /** One segment of the path the route's pattern admitted ("/flows/1/cards/2/move" → 2 is "1", 4 is "2"). */
  const pathPart = (url: URL, index: number): string => url.pathname.split("/")[index] ?? "";
  /** A flow the caller may see: active, in a visible project. */
  const visibleFlow = (id: number) => {
    const flow = store.getFlow(id);
    return flow === null || flow.state !== "active" || !visible(flow.repo) ? null : flow;
  };
  /** A subagent the caller may see: not removed, in a visible project the account can access. */
  const visibleSubagent = (who: Who, id: number) => {
    const mate = store.getSubagent(id);
    return mate === null || mate.state === "removed" || !visible(mate.repo) || !store.accountCanAccess(who.name, mate.repo) ? null : mate;
  };
  const sendJson = (response: ServerResponse, status: number, payload: unknown) => respond(response, status, "application/json; charset=utf-8", JSON.stringify(payload));

  // ---- flows: reads ----------------------------------------------------------

  // Flows → New: the gallery, and each template's page.
  async function newFlowGallery(ctx: HandlerContext): Promise<void> {
    const { url, response, who, project } = ctx;
    const projects = consoleProjects();
    const canUse = who.via === "cookie" && who.role === "approver" && projects.length > 0;
    // The chosen project, else the one being looked at: its tools are what each card says is connected.
    const asked = url.searchParams.get("repo");
    const repo = asked !== null && projects.includes(asked) ? asked : project !== null && projects.includes(project) ? project : null;
    return sendScreen(response, 200, screen("New flow", html`<p><a href="/flows">Flows</a></p><h1>New flow</h1>${(galleryHtml({ repo, canUse, connections: repo === null ? null : connectionsOf(store, repo) }))}`, { chrome: chromeFor(repo ?? project, "flows") }));
  }

  async function galleryTemplatePage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    const template = galleryTemplateOf(pathPart(url, 3));
    const projects = consoleProjects();
    if (template === null) return refuse(response, who, 404, "There's no template by that name.", "/flows/new");
    // Not in the route table: an unknown template is a 404 for anyone first.
    if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "Sign in as an approver to create flows.", "/flows/new");
    if (projects.length === 0) return refuse(response, who, 409, "Add a project first.", "/projects");
    const asked = url.searchParams.get("repo");
    const repo = asked !== null && projects.includes(asked) ? asked : project !== null && projects.includes(project) ? project : projects[0]!;
    // Back from a Connect started on this page: how it went.
    const problem = url.searchParams.get("problem"), said = url.searchParams.get("said");
    return sendGalleryUse(response, who, template, projects, repo, null, template.name, problem === null ? null : problem.slice(0, 400), said === null ? null : said.slice(0, 400));
  }

  async function flowsPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    const projects = consoleProjects();
    const flows = store.listFlows(projects);
    return sendScreen(response, 200, screen("Flows", html`<h1>Flows</h1>${(flowsListHtml(store, flows, projects, who.via === "cookie" && who.role === "approver", url.searchParams.get("problem")))}`, { chrome: chromeFor(project, "flows"), functional: { script: FLOW_IMPORT_SCRIPT } }));
  }

  async function flowInsightsRead(ctx: HandlerContext): Promise<void> {
    const { url, response } = ctx;
    const flow = visibleFlow(Number(pathPart(url, 2)));
    if (flow === null) return sendJson(response, 404, { said: "No such flow in your projects." });
    return sendJson(response, 200, flowInsights(store, flow, clock(), Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30))));
  }

  async function flowRunRead(ctx: HandlerContext): Promise<void> {
    const { url, response } = ctx;
    const flow = visibleFlow(Number(pathPart(url, 2)));
    if (flow === null) return sendJson(response, 404, { said: "No such flow in your projects." });
    const card = store.getFlowCard(Number(pathPart(url, 4)));
    const run = card === null || card.flow !== flow.id ? null : store.flowStepRun(card.id, Number(pathPart(url, 5)));
    if (run === null) return sendJson(response, 404, { said: "No such run." });
    return sendJson(response, 200, { card: run.card, entry: run.entry, script: run.script, version: run.scriptVersion, state: run.state, result: run.result, exitCode: run.exitCode, durationMs: run.durationMs, at: run.finishedAt ?? run.startedAt, log: run.log ?? "" });
  }

  // A flow as a file (flow-share.ts): zones, paths, trigger settings and scripts; never secrets, addresses, names or cards.
  async function flowExportFile(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    const flow = visibleFlow(Number(pathPart(url, 2)));
    if (flow === null) return refuse(response, who, 404, "No such flow in your projects.", "/flows");
    let exported: ReturnType<typeof exportFlow>;
    try { exported = exportFlow(store, flow, options.configDir ?? null); }
    catch (error) { return refuse(response, who, 409, error instanceof Error ? error.message : "This flow can't be exported.", `/flows/${flow.id}`); }
    response.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
    return respond(response, 200, "application/json; charset=utf-8", exported.json);
  }

  async function flowPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    const flow = visibleFlow(Number(pathPart(url, 2)));
    if (flow === null) return refuse(response, who, 404, "No such flow in your projects.", "/flows");
    const selected = Number(url.searchParams.get("card")), start = Number(url.searchParams.get("start"));
    const view = flowView(store, flow, { name: who.name, approver: who.via === "cookie" && who.role === "approver" }, Number.isSafeInteger(selected) && selected > 0 ? selected : null,
      { dir: options.configDir ?? null, repos: consoleProjects(), startTrigger: Number.isSafeInteger(start) && start > 0 ? start : null,
        sortReady: keyStatus("openrouter", providerHome).set, toolHome });
    if (url.searchParams.get("format") === "json") return respond(response, 200, "application/json; charset=utf-8", JSON.stringify(checkResponse("flowView", view)));
    return sendScreen(response, 200, screen(flow.name, html`<p><a href="/flows">Flows</a></p><h1>${flow.name}</h1>${flowFallbackHtml(view)}`, { chrome: chromeFor(flow.repo, "flows"), workspace: { view } }));
  }

  // ---- starter kits: the gallery, and each kit's checklist in a project ------

  async function kitsGallery(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    const projects = consoleProjects();
    const canSetUp = who.via === "cookie" && who.role === "approver";
    return sendScreen(response, 200, screen("Starter kits", html`<h1>Starter kits</h1>${(kitsGalleryHtml(store, projects, projectName, canSetUp, { problem: url.searchParams.get("problem") }))}`, { chrome: chromeFor(project, "flows") }));
  }

  async function kitPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    const projects = consoleProjects();
    const canSetUp = who.via === "cookie" && who.role === "approver";
    const kit = kitOf(pathPart(url, 2));
    const repo = url.searchParams.get("repo") ?? (projects.length === 1 ? projects[0]! : "");
    if (kit === null || !projects.includes(repo)) return redirect(response, "/kits");
    return sendScreen(response, 200, screen(kit.name, html`<h1>${kit.name}</h1>${(kitPageHtml(store, kit, repo, options.configDir ?? null, canSetUp, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") }))}`, { chrome: chromeFor(repo, "flows") }));
  }

  // ---- v92 / D5: the lead's subagents — the list, and one page per subagent ----

  async function subagentsPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response, project } = ctx;
    const projects = consoleProjects();
    return sendScreen(response, 200, screen("Subagents", html`<p><a href="/settings/lead">Lead</a></p><h1>Subagents</h1>${(subagentsListHtml(store, store.subagents(projects), projects, projectName, who.via === "cookie" && who.role === "approver",
      { said: url.searchParams.get("said"), problem: url.searchParams.get("problem"), adding: url.searchParams.get("add") === "1" }))}`, { chrome: chromeFor(project, "settings") }));
  }

  /** D5: subagents were teammates; an old link lands on the same page under Settings → Lead. */
  async function legacySubagentLink(ctx: HandlerContext): Promise<void> {
    const { url, response } = ctx;
    const legacy = /^\/teammates(?:\/([1-9][0-9]{0,9})(\/soul\.md)?)?$/.exec(url.pathname);
    return redirect(response, legacy === null || legacy[1] === undefined ? "/settings/lead#subagents" : `/settings/lead/subagents/${legacy[1]}${legacy[2] ?? ""}`);
  }

  async function subagentPage(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    const mate = visibleSubagent(who, Number(pathPart(url, 4)));
    if (mate === null) return refuse(response, who, 404, "No such subagent in your projects.", "/settings/lead/subagents");
    const approvers = store.listApprovers().map(one => one.name).filter(name => store.accountCanAccess(name, mate.repo));
    return sendScreen(response, 200, screen(labelOf(mate), html`<p><a href="/settings/lead">Lead</a></p><h1>${labelOf(mate)}</h1>${(subagentPageHtml(store, mate, who.name, projectName, who.via === "cookie" && who.role === "approver", approvers,
      { said: url.searchParams.get("said"), problem: url.searchParams.get("problem"), query: url.searchParams.get("q") }))}`, { chrome: chromeFor(mate.repo, "settings") }));
  }

  async function subagentSoulFile(ctx: HandlerContext): Promise<void> {
    const { url, who, response } = ctx;
    const mate = visibleSubagent(who, Number(pathPart(url, 4)));
    if (mate === null) return refuse(response, who, 404, "No such subagent in your projects.", "/settings/lead/subagents");
    response.writeHead(200, { ...SAFETY, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${mate.handle}.md"` });
    return void response.end(mate.soul);
  }

  // ---- workflow recipes: reads -----------------------------------------------

  type RecipeScreen = "run" | "start" | "new" | "edit" | "from-task" | "preview" | "export" | "other";

  async function recipeLibrary(ctx: HandlerContext): Promise<void> {
    const { who, response, project } = ctx;
    try {
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      const recent = project === null ? [] : store.handle.prepare("SELECT document,task_id,flow_id FROM workflow_preview WHERE repo=? AND (task_id IS NOT NULL OR flow_id IS NOT NULL) ORDER BY created_at DESC LIMIT 12").all(project).map(row => {
        const d = importRecipe(String(row["document"]));
        const task = row["task_id"] === null ? null : store.getTask(String(row["task_id"]));
        const flow = row["flow_id"] === null ? null : store.getFlow(Number(row["flow_id"]));
        const on = flow !== null && flow.state === "active" && store.flowTriggers(flow.id).some(one => one.kind === "schedule" && one.state === "active");
        return { name: d.name, href: task !== null ? taskHref(task.id) : `/flows/${Number(row["flow_id"])}`, state: task?.state ?? (flow === null || flow.state !== "active" ? "Archived" : on ? "Scheduled" : "Paused") };
      });
      return sendScreen(response, 200, screen("Workflow recipes", recipeLibraryHtml(starterRecipes(), project === null ? [] : savedRecipes(store, who.name, project), project, revision, recent), { chrome: chromeFor(project, "recipes"), functional: { script: recipeScript() } }));
    } catch (error) {
      if (error instanceof RecipeError) return refuse(response, who, error.status, error.message, "/recipes");
      throw error;
    }
  }

  /** One recipe screen in the open project: the editor (start, new, edit, from a task), use, preview, export; any other address is no screen. */
  const recipeScreen = (shown: RecipeScreen) => async (ctx: HandlerContext): Promise<void> => {
    const { url, who, response, now, project } = ctx;
    try {
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      const render = (page: Html) => sendScreen(response, 200, screen("Workflow recipes", page, { chrome: chromeFor(project, "recipes"), functional: { script: recipeScript() } }));
      if (project === null) return refuse(response, who, 400, "Open a project to customize a recipe.", "/projects");
      const token = url.searchParams.get("preview");
      const preview = token === null ? null : workflowPreview(store, who.name, project, token);
      if (token !== null && preview === null) return refuse(response, who, 404, "No preview in this project.", "/recipes");
      const sourceRevision = url.searchParams.get("revision");
      if (sourceRevision !== null && !/^[1-9][0-9]{0,8}$/.test(sourceRevision)) throw new RecipeError("Choose a valid recipe version.");
      let recipe = preview === null ? findRecipe(store, who.name, project, url.searchParams.get("recipe") ?? "", sourceRevision === null ? undefined : Number(sourceRevision))
        : { id: preview.source, revision: 1, repo: project, document: preview.document, digest: preview.digest, author: who.name };
      if (shown === "new") {
        const starter = starterRecipes().find(one => one.id === "small-feature")!;
        recipe = { ...starter, id: "custom", document: { ...starter.document, name: "", description: "", goal: "", outOfScope: null, acceptance: [] } };
      }
      if (shown === "start" && recipe?.id === "small-feature") {
        // This starter supplies the process, but the person supplies the
        // feature. Do not let instructional placeholder text become work.
        recipe = { ...recipe, document: { ...recipe.document, goal: "" } };
      }
      if (shown === "from-task") {
        const id = url.searchParams.get("task") ?? "";
        const ref = store.lookupRef(id), task = store.getTask(id), scope = store.getScope(id);
        if (ref?.repo !== project || task === null || scope === null) throw new RecipeError("No scoped task in this project.", 404);
        recipe = { id: "task-copy", revision: 1, repo: project, digest: "", author: who.name, document: {
          format: "standing-orders-recipe", version: 1, name: task.title, description: "Scope and success checks copied from a task. Dependencies, budgets, agents, and approvals use the new work's settings.", goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, acceptance: scope.acceptance,
          planning: "auto", deliverable: ref.deliverable === "report" ? "report" : "branch", schedule: null, costCeilingUsd: null,
        } };
      }
      if (shown === "run") {
        if (recipe === null || recipe.repo === null) throw new RecipeError("Save a project recipe before using it here.", 404);
        return render(recipeRunHtml(recipe, project, revision, null, undefined, url.searchParams.get("saved") === "1"));
      }
      if (shown === "preview" && preview !== null) {
        if (preview.document.version === 2 || url.searchParams.get("purpose") === "recipe") return render(recipeDefinitionPreviewHtml(preview, revision));
        const agents = resolveAgentAuthority(store, project, preview.document.acceptance, now);
        const workers = store.listRunners().filter(one => one.retiredAt === null && one.repos.includes(project) && runnerAlive(one, now));
        const mode = store.activeMode(project, now);
        const readiness = [
          { title: "Project", detail: projectName(project) },
          { title: agents.ok ? "Agents configured" : "Choose your agents", detail: agents.ok ? "The project has an exact agent route. The created work will show the agents it binds." : agents.problem, ...(!restricted() && !agents.ok ? { href: "/control" } : {}) },
          { title: workers.length ? "Worker connected" : "Worker needed", detail: workers.length ? `${workers.length} worker${workers.length === 1 ? " is" : "s are"} answering for this project.` : "Open Toolroll on the machine with this project. Work waits safely until a worker connects." },
          { title: "Approval", detail: mode?.signedBy === who.name ? "Your signed project policy is available. Its scope, expiry, and approval options will be checked at filing." : "Review and approve the created work before it starts.", ...(!restricted() ? { href: "/mode" } : {}) },
        ];
        return render(workflowPreviewHtml(preview, revision, now, readiness, mode?.signedBy === who.name));
      }
      if (recipe === null) return refuse(response, who, 404, "No recipe in this project.", "/recipes");
      if (shown === "export") {
        response.setHeader("Content-Disposition", 'attachment; filename="standing-orders-recipe.json"');
        return respond(response, 200, "application/json; charset=utf-8", exportRecipe(recipe.document));
      }
      if (shown === "start" || shown === "new" || shown === "edit" || shown === "from-task") return render(recipeEditorHtml(recipe, project, revision, null, undefined, shown === "new" || shown === "from-task" || (shown === "start" && recipe.repo !== null) || recipe.document.version === 2 || url.searchParams.get("purpose") === "recipe"));
      return refuse(response, who, 404, "No recipe screen here.", "/recipes");
    } catch (error) {
      if (error instanceof RecipeError) return refuse(response, who, error.status, error.message, "/recipes");
      throw error;
    }
  };

  // ---- starter kits: changes -------------------------------------------------

  type KitStep = "setup" | "sample" | "github";
  // setting a starter kit up, trying its sample card, and bringing GitHub issues in.
  const kitAct = (step: KitStep) => async (ctx: HandlerContext): Promise<void> => {
    const { url, who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.kit);
    const now = clock();
    const kit = kitOf(pathPart(url, 2));
    const projects = consoleProjects();
    const repo = body.get("repo") ?? "";
    if (kit === null || !projects.includes(repo) || !store.accountCanAccess(who.name, repo)) return redirect(response, `/kits?problem=${encodeURIComponent("Choose one of your projects.")}`);
    const page = (key: "said" | "problem", words: string) => redirect(response, `/kits/${kit.id}?repo=${encodeURIComponent(repo)}&${key}=${encodeURIComponent(words)}`);
    if (step === "setup") {
      const made = await setUpKit(store, kit, repo, who.name, now, options.configDir ?? null, { toolHome });
      return page(made.ok ? "said" : "problem", made.said);
    }
    if (step === "github") {
      const made = addKitGithubTrigger(store, kit, repo, who.name, now, options.configDir ?? null);
      return page(made.ok ? "said" : "problem", made.said);
    }
    const tried = addKitSample(store, kit, repo, who.name, now);
    if (!tried.ok) return page("problem", tried.said);
    // The subagent picks it up on the worker's next pass (a few seconds); its flow opens on the card.
    try { advanceFlows(store, repo, now, { evidenceRoot }); } catch { /* the worker's next pass moves it */ }
    return redirect(response, tried.href);
  };

  // ---- v92: looking after subagents, and answering their questions -----------

  async function answerSubagentQuestionSend(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.subagents);
    const now = clock();
    const wantsJson = (request.headers.accept ?? "").includes("application/json");
    if (who.via !== "cookie") return refuse(response, who, 403, "Sign in to do that.", "/settings/lead/subagents");
    const question = store.subagentQuestion(Number(pathPart(url, 5)));
    const card = question === null ? null : store.getFlowCard(question.card);
    const flow = card === null ? null : store.getFlow(card.flow);
    const done = question === null || flow === null || !visible(flow.repo) ? { ok: false as const, said: "No such question." }
      : answerSubagentQuestion(store, question.id, { choice: body.get("choice"), text: body.get("text"), by: who.name, via: "web" }, now);
    if (wantsJson) return respond(response, done.ok ? 200 : 409, "application/json; charset=utf-8", JSON.stringify(done));
    const back = question === null ? "/settings/lead/subagents" : `/settings/lead/subagents/${question.subagent}`;
    return redirect(response, `${back}?${done.ok ? "said" : "problem"}=${encodeURIComponent(done.said)}`);
  }

  async function newSubagent(ctx: HandlerContext): Promise<void> {
    const { who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.subagents);
    const now = clock();
    if (who.via !== "cookie") return refuse(response, who, 403, "Sign in to do that.", "/settings/lead/subagents");
    const projects = consoleProjects();
    const repo = body.get("repo") ?? "";
    if (!projects.includes(repo)) return redirect(response, `/settings/lead/subagents?problem=${encodeURIComponent("Choose one of your projects.")}`);
    const template = body.get("template") ?? "";
    const made = createSubagentFrom(store, { repo, template: template === "blank" ? null : template, name: body.get("name"), soul: template === "blank" ? BLANK_SOUL.replace("name: \n", `name: ${(body.get("name") ?? "").trim() || "Sam"}\n`).replace("role: \n", "role: Assistant\n") : null, by: who.name }, now);
    return made.ok ? redirect(response, `/settings/lead/subagents/${made.id}?said=${encodeURIComponent(made.said)}`) : redirect(response, `/settings/lead/subagents?problem=${encodeURIComponent(made.said)}`);
  }

  type SubagentPart = "soul" | "state" | "note" | "settings" | "summary" | "tools" | "memory" | "routines" | "week";
  const subagentAct = (part: SubagentPart) => async (ctx: HandlerContext): Promise<void> => {
    const { url, who, request, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.subagents);
    const now = clock();
    const wantsJson = (request.headers.accept ?? "").includes("application/json");
    if (who.via !== "cookie") return refuse(response, who, 403, "Sign in to do that.", "/settings/lead/subagents");
    const mate = visibleSubagent(who, Number(pathPart(url, 4)));
    if (mate === null) return refuse(response, who, 404, "No such subagent in your projects.", "/settings/lead/subagents");
    const back = `/settings/lead/subagents/${mate.id}`;
    if (part === "soul") {
      const soul = body.get("soul") ?? "";
      const saved = saveSoul(store, mate, soul, who.name, now);
      if (!saved.ok) {
        const approvers = store.listApprovers().map(one => one.name).filter(name => store.accountCanAccess(name, mate.repo));
        return sendScreen(response, 400, screen(labelOf(mate), html`<h1>${labelOf(mate)}</h1>${subagentPageHtml(store, mate, who.name, projectName, true, approvers, { problem: saved.said, soulDraft: soul })}`, { chrome: chromeFor(mate.repo, "flows") }));
      }
      return redirect(response, `${back}?said=${encodeURIComponent(saved.said)}`);
    }
    if (part === "week") {
      // v97: undo one of its tool calls, or send the week's report now.
      const done = body.get("op") === "undo" ? await undoCall(store, mate, Number(body.get("id")), who.name, { toolHome }, now)
        : sendSubagentWeeklies(store, mate.repo, now, mate.id) > 0 ? { ok: true as const, said: `Sent the week's report to ${mate.manager}.` } : { ok: false as const, said: "The report couldn't be sent." };
      if (wantsJson) return respond(response, done.ok ? 200 : 409, "application/json; charset=utf-8", JSON.stringify(done));
      return redirect(response, `${back}?${done.ok ? "said" : "problem"}=${encodeURIComponent(done.said)}#week`);
    }
    if (part === "routines") {
      // v96: its routines: add one, try one now, or remove one.
      const op = body.get("op"), routine = Number(body.get("id"));
      const hooks = options.configDir ?? null;
      const changed = op === "add" ? addRoutine(store, mate, body.get("schedule") ?? "", body.get("text") ?? "", who.name, now, hooks)
        : op === "run" ? runRoutine(store, mate, routine, who.name, now)
        : removeRoutine(store, mate, routine, now, hooks);
      if (changed.ok && op === "run") { try { advanceFlows(store, mate.repo, now, { evidenceRoot }); } catch { /* the worker's next pass moves it */ } }
      return redirect(response, `${back}?${changed.ok ? "said" : "problem"}=${encodeURIComponent(changed.said)}#desk`);
    }
    if (part === "memory") {
      // v95: edit or forget one thing it remembers.
      const memory = Number(body.get("id"));
      const changed = body.get("op") === "forget" ? forgetMemory(store, mate, memory, who.name, now) : editMemory(store, mate, memory, body.get("text") ?? "", who.name, now);
      return redirect(response, `${back}?${changed.ok ? "said" : "problem"}=${encodeURIComponent(changed.said)}#memory`);
    }
    if (part === "tools") {
      // v94: which project tools it may use, and its rule for each action.
      const tool = body.get("tool") ?? "", op = body.get("op");
      const grant = store.subagentGrant(mate.id, tool);
      const changed = op === "grant" ? await grantTool(store, mate, tool, who.name, now, { toolHome })
        : op === "revoke" ? revokeTool(store, mate, tool, who.name, now)
        : grant === null ? { ok: false as const, said: `${nameOf(mate)} doesn't use ${tool}.` } : setToolRules(store, mate, tool, rulesFromForm(grant, key => body.sent.get(key)), who.name, now);
      return redirect(response, `${back}?${changed.ok ? "said" : "problem"}=${encodeURIComponent(changed.said)}#tools`);
    }
    const done = part === "state" ? setSubagentState(store, mate, body.get("state") === "removed" ? "removed" : body.get("state") === "paused" ? "paused" : "active", who.name, now)
      : part === "note" ? tellSubagent(store, mate, body.get("note") ?? "", who.name, now)
      : part === "settings" ? subagentSettings(store, mate, { model: body.get("model") ?? "default", dailyTurns: Number(body.get("dailyTurns")), manager: body.get("manager") ?? mate.manager }, who.name, now)
      : sendSubagentSummaries(store, mate.repo, now, mate.id) > 0 ? { ok: true as const, said: `Sent today's summary to ${mate.manager}.` } : { ok: false as const, said: "The summary couldn't be sent." };
    if (part === "state" && body.get("state") === "removed" && done.ok) return redirect(response, `/settings/lead/subagents?said=${encodeURIComponent(done.said)}`);
    return redirect(response, `${back}?${done.ok ? "said" : "problem"}=${encodeURIComponent(done.said)}${part === "note" ? "#memory" : ""}`);
  };

  // ---- flows: making one -----------------------------------------------------

  // Flows → New → a template: preview these answers, or create exactly what was previewed.
  async function createFromGallery(ctx: HandlerContext): Promise<void> {
    const { url, who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.galleryUse);
    const template = galleryTemplateOf(pathPart(url, 3));
    const projects = consoleProjects();
    if (template === null) return refuse(response, who, 404, "There's no template by that name.", "/flows/new");
    // Not in the route table: an unknown template is a 404 for anyone first, and a demo creates nothing.
    if (who.via !== "cookie" || who.role !== "approver" || store.isDemo()) return refuse(response, who, 403, "Sign in as an approver to create flows.", "/flows/new");
    const repo = body.get("repo") ?? "";
    if (!projects.includes(repo)) return refuse(response, who, 404, "Choose one of your projects.", "/flows/new");
    const answers: GalleryAnswers = { ...Object.fromEntries(template.asks.map(ask => [ask.key, body.get(ask.key) ?? ""])), ...(body.get("send-result") === "yes" ? { "send-result": "yes" } : {}) };
    const name = (body.get("name") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || template.name;
    if (body.get("intent") !== "create") return sendGalleryUse(response, who, template, projects, repo, answers, name, null);
    // What's made is what was previewed: changed answers are previewed again first.
    let digest: string | null = null;
    try { digest = previewGallery(store, template, repo, answers, who.name, clock()).digest; } catch { digest = null; }
    if (digest === null || digest !== body.get("previewed")) return sendGalleryUse(response, who, template, projects, repo, answers, name, digest === null ? null : "Your answers changed. Check the preview, then create the flow.");
    const used = useGalleryTemplate(store, template, repo, answers, { name, by: who.name, now: clock(), dir: options.configDir ?? null });
    if (!used.ok) return sendGalleryUse(response, who, template, projects, repo, answers, name, used.said);
    return redirect(response, `/flows/${used.flow}`);
  }

  async function createFlow(ctx: HandlerContext): Promise<void> {
    const { who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.flows);
    const now = clock();
    const projects = consoleProjects();
    const repo = body.get("repo") ?? "";
    if (!projects.includes(repo)) return redirect(response, `/flows?problem=${encodeURIComponent("Choose one of your projects.")}`);
    const template = FLOW_TEMPLATES.find(one => one.id === body.get("template")) ?? FLOW_TEMPLATES[0]!;
    const name = (body.get("name") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || template.label;
    const made = store.createFlow({ repo, name, definitionJson: JSON.stringify(template.definition), by: who.name }, now);
    // A template that starts from something (Issues to PRs: labelled issues) comes with its trigger.
    const trigger = template.trigger === undefined ? null : addFlowTriggerTo(store, store.getFlow(made)!, template.trigger, who.name, now, options.configDir ?? null);
    if (trigger !== null && !trigger.ok) return redirect(response, `/flows?problem=${encodeURIComponent(`${name} was made, but its trigger wasn't: ${trigger.message} Add one on its Triggers panel.`)}`);
    return redirect(response, `/flows/${made}`);
  }

  // A first look (v88): the Email replies template with one sample question, which Claude drafts a reply to straight away.
  async function createExampleFlow(ctx: HandlerContext): Promise<void> {
    const { who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.flows);
    const now = clock();
    const projects = consoleProjects();
    const repo = body.get("repo") ?? "";
    if (!projects.includes(repo)) return redirect(response, `/flows?problem=${encodeURIComponent("Choose one of your projects.")}`);
    const template = FLOW_TEMPLATES.find(one => one.id === "email-replies")!;
    const id = store.createFlow({ repo, name: "Customer replies (example)", definitionJson: JSON.stringify(template.definition), by: who.name }, now);
    addCardToFlow(store, store.getFlow(id)!, { title: "Do you ship to Canada?", description: "Hi! I'm thinking of ordering but I live in Toronto. Do you ship there, and how long does it take? — sam@example.com", stage: null }, who.name, now);
    return redirect(response, `/flows/${id}`);
  }

  // A flow file, chosen or fetched from a gist: previewed in plain words, then made with its triggers off and its scripts held.
  async function importFlowFile(ctx: HandlerContext): Promise<void> {
    const { who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.flows);
    const now = clock();
    const projects = consoleProjects();
    const repo = body.get("repo") ?? "";
    const back = (problem: string) => redirect(response, `/flows?problem=${encodeURIComponent(problem)}`);
    if (!projects.includes(repo)) return back("Choose one of your projects.");
    let document = body.get("document") ?? "";
    const address = (body.get("url") ?? "").trim();
    let file: ReturnType<typeof parseFlowFile>;
    try {
      if (document.trim() === "" && address !== "") document = await fetchFlowFile(address, options.flowFetch);
      if (document.trim() === "") return back("Choose a flow file or give its address.");
      file = parseFlowFile(document);
    } catch (error) {
      if (error instanceof FlowFileError) return back(error.message);
      throw error;
    }
    const given = Object.fromEntries(file.parameters.flatMap(one => body.has(`param.${one.id}`) ? [[one.id, body.get(`param.${one.id}`) ?? ""]] : []));
    // What was previewed: the file and every value it resolved to (a default the first preview filled in included).
    const previewedOf = (plan: FlowImportPlan | null) => createHash("sha256").update(`${document}\0${JSON.stringify(plan?.values ?? given)}`).digest("hex").slice(0, 32);
    const csrf = who.via === "cookie" ? who.session.csrf : "";
    const page = (plan: FlowImportPlan | null, problem: string | null, status: number) => sendScreen(response, status, screen(`Import ${file.name}`,
      html`<p><a href="/flows">Flows</a></p><h1>Import ${file.name}</h1>${(flowImportHtml({ plan, file, document, repo, csrf, values: given, previewed: previewedOf(plan), problem }))}`, { chrome: chromeFor(repo, "flows") }));
    let plan: FlowImportPlan;
    try { plan = planFlowImport(store, repo, file, given, who.name); }
    catch (error) {
      if (error instanceof FlowFileError) return page(null, error.message, 400);
      throw error;
    }
    if (body.get("confirm") === "yes") {
      if (body.get("previewed") !== previewedOf(plan)) return page(plan, "What you filled in changed. Check the preview again, then import.", 409);
      try { return redirect(response, `/flows/${importFlow(store, plan, who.name, now, options.configDir ?? null).id}`); }
      catch (error) { return page(plan, error instanceof Error ? error.message : "That flow couldn't be imported.", 400); }
    }
    return page(plan, null, 200);
  }

  // ---- flows: changing one (answers the editor's JSON) -----------------------

  /** What every change to one flow starts from: its form, the flow (else the editor hears 404), and how a change settles. Null once answered. */
  function openFlowChange(ctx: HandlerContext) {
    const { url, who, response, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.flows);
    const now = clock();
    const answer = (status: number, payload: Record<string, unknown>) => sendJson(response, status, payload);
    const projects = consoleProjects();
    const flow = visibleFlow(Number(pathPart(url, 2)));
    if (flow === null) { answer(404, { ok: false, said: "No such flow in your projects." }); return null; }
    const definition = flowDefinitionOf(flow);
    const dir = options.configDir ?? null;
    const viewNow = () => flowView(store, store.getFlow(flow.id) ?? flow, { name: who.name, approver: true }, null, { dir, repos: projects, sortReady: keyStatus("openrouter", providerHome).set, toolHome });
    const settle = (said: string, extra: Record<string, unknown> = {}) => {
      // Move what can move right away (a message, a decision's next zone); workers file and run the tasks.
      try { advanceFlows(store, flow.repo, now, { evidenceRoot }); } catch { /* the next worker pass retries */ }
      return answer(200, { ok: true, said, view: viewNow(), ...extra });
    };
    return { body, now, answer, projects, flow, definition, dir, viewNow, settle };
  }

  type FlowAction = "save" | "cards" | "archive" | "scripts" | "linear-key" | "hooks-address" | "secrets" | "triggers";
  const flowAct = (action: FlowAction) => async (ctx: HandlerContext): Promise<void> => {
    const { who, response } = ctx;
    const change = openFlowChange(ctx);
    if (change === null) return;
    const { body, now, answer, flow, definition, dir, settle } = change;
    if (action === "triggers") {
      let raw: unknown;
      try { raw = JSON.parse(body.get("trigger") ?? "null"); } catch { return answer(400, { ok: false, said: "That trigger couldn't be read." }); }
      const made = addFlowTriggerTo(store, flow, raw, who.name, now, dir);
      return made.ok ? settle(made.said, made.reveal === null ? {} : { reveal: made.reveal }) : answer(400, { ok: false, said: made.message });
    }
    if (action === "scripts") {
      // The project's script library, reached from any of its flows.
      if (body.get("approve") === "yes") return store.approveFlowScript(flow.repo, body.get("name") ?? "") ? settle("Approved. Zones that run it go on.") : answer(404, { ok: false, said: "That script isn't waiting for approval." });
      if (body.get("remove") === "yes") return store.removeFlowScript(flow.repo, body.get("name") ?? "") ? settle("Script removed. Zones that ran it wait until it's back.") : answer(404, { ok: false, said: "There's no script by that name." });
      const saved = saveScript(store, flow.repo, { name: body.get("name"), about: body.get("about"), body: body.get("body"), timeoutMinutes: body.get("timeoutMinutes"), language: body.get("language"), file: body.get("file") }, who.name, now);
      return saved.ok ? settle(saved.said) : answer(400, { ok: false, said: saved.message });
    }
    if (action === "linear-key" || action === "hooks-address") {
      // Installation settings, set from the flow they are needed on.
      if (dir === null) return answer(409, { ok: false, said: "These settings are kept on the console's computer." });
      if (action === "hooks-address") {
        const saved = saveHooksBase(dir, body.get("address") ?? "");
        return saved.ok ? settle(saved.base === null ? "Public address cleared." : "Public address saved.") : answer(400, { ok: false, said: saved.message });
      }
      if (body.get("remove") === "yes") { removeLinearKey(dir); return settle("Linear key removed."); }
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return answer(403, { ok: false, said: "Enter your Toolroll password to save a key." });
      const saved = saveLinearKey(dir, body.get("key") ?? "");
      return saved.ok ? settle("Linear key saved on this computer.") : answer(400, { ok: false, said: saved.message });
    }
    if (action === "archive") { store.archiveFlow(flow.id, who.name, now); return redirect(response, "/flows"); }
    if (action === "save") {
      let saved, drawn: unknown;
      try {
        drawn = JSON.parse(body.get("definition") ?? "null"); saved = validateFlowDefinition(drawn);
        // A {{stage.…}} this save adds must be one its zone hands on; ones the saved flow had stay.
        const references = stageReferenceProblems(saved, flowDefinitionOf(flow));
        if (references.length > 0) throw new FlowContractError(references.map(one => one.line));
      }
      catch (error) { return answer(400, { ok: false, said: error instanceof SyntaxError ? "That flow couldn't be read." : error instanceof FlowContractError ? withZoneNames(error.lines, drawn) : error instanceof Error ? error.message : "That flow isn't valid." }); }
      const name = (body.get("name") ?? flow.name).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || flow.name;
      // The owner (v86) is whom "the owner decides" zones ask: someone who can approve on this project.
      const owner = (body.get("owner") ?? "").trim();
      if (owner !== "" && owner !== flow.owner && !(store.listApprovers().some(one => one.name === owner) && store.accountCanAccess(owner, flow.repo))) return answer(400, { ok: false, said: `${owner} can't approve on this project, so they can't own this flow.` });
      // A build zone in another project files work there as the flow's owner: only in one they may file in.
      const elsewhere = crossProjectProblem(store, saved, { repo: flow.repo, owner: owner || flow.owner }, who.name);
      if (elsewhere !== null) return answer(400, { ok: false, said: elsewhere });
      if (!store.saveFlow(flow.id, { name, definitionJson: JSON.stringify(saved), sawRevision: Number(body.get("revision")), by: who.name }, now)) return answer(409, { ok: false, said: "Someone else changed this flow. Reload to see their changes, then make yours again." });
      if (owner !== "" && owner !== flow.owner) store.setFlowOwner(flow.id, owner, now);
      return settle("Saved.");
    }
    if (action === "secrets") {
      // A web request's secret: written here, used only in its headers, never shown back.
      if (dir === null) return answer(409, { ok: false, said: "Secrets are kept on the console's computer." });
      const saved = setFlowSecret(dir, flow.repo, (body.get("name") ?? "").trim(), body.get("value") ?? "");
      return saved.ok ? settle(saved.said) : answer(400, { ok: false, said: saved.message });
    }
    // Adding a card.
    if (definition === null) return answer(409, { ok: false, said: "This flow's drawing can't be read. Save it again from the editor." });
    const added = addCardToFlow(store, flow, { title: body.get("title"), description: body.get("description"), stage: body.get("stage") }, who.name, now);
    return added.ok ? settle("Card added.") : answer(400, { ok: false, said: added.message });
  };

  type CardVerb = "move" | "decide" | "choose" | "cancel" | "comment" | "assign" | "watch";
  const cardAct = (verb: CardVerb) => async (ctx: HandlerContext): Promise<void> => {
    const { url, who } = ctx;
    const change = openFlowChange(ctx);
    if (change === null) return;
    const { body, now, answer, projects, flow, definition, settle } = change;
    if (definition === null) return answer(409, { ok: false, said: "This flow's drawing can't be read. Save it again from the editor." });
    const target = store.getFlowCard(Number(pathPart(url, 4)));
    if (target === null || target.flow !== flow.id) return answer(404, { ok: false, said: "That card isn't in this flow." });
    if (verb === "move") {
      if (!definition.stages.some(one => one.id === body.get("stage"))) return answer(400, { ok: false, said: "Choose a zone in this flow." });
      const moved = moveCardInFlow(store, target, body.get("stage") ?? "", who.name, now);
      return !moved.ok ? answer(409, { ok: false, said: moved.message }) : moved.said === "Already there." ? answer(200, { ok: true, said: moved.said }) : settle(moved.said);
    }
    if (verb === "decide") {
      const decision = body.get("decision") === "approve" ? "approve" : body.get("decision") === "send-back" ? "send-back" : null;
      if (decision === null) return answer(400, { ok: false, said: "Approve it or send it back." });
      const note = (body.get("note") ?? "").trim() || null;
      if (note !== null && note.length > LIMITS.note) return answer(400, { ok: false, said: `Keep the note to ${LIMITS.note.toLocaleString("en-US")} characters; this is ${note.length.toLocaleString("en-US")}.` });
      const decided = decideFlowCard(store, { card: target.id, decision, note, actor: who.name, repos: projects, evidenceRoot, draft: body.get("draft"), where: "the console" }, now);
      return decided.ok ? settle(decided.said) : answer(409, { ok: false, said: decided.message });
    }
    if (verb === "choose") {
      // "Person chooses": one of the zone's options (by its place and words), or a reply that becomes the note.
      const choice = /^[0-9]$/.test(body.get("choice") ?? "") ? Number(body.get("choice")) : null;
      const chosen = chooseFlowCard(store, { card: target.id, ...(/^[1-9][0-9]{0,9}$/.test(body.get("entry") ?? "") ? { entry: Number(body.get("entry")) } : {}), choice,
        ...(choice !== null && body.get("label") !== null ? { label: body.get("label")! } : {}), note: choice === null ? body.get("note") : null, actor: who.name, where: "Toolroll", repos: projects, evidenceRoot }, now);
      return chosen.ok ? settle(chosen.said) : answer(409, { ok: false, said: chosen.message });
    }
    if (verb === "comment") {
      const commented = commentOnFlowCard(store, target, who.name, body.get("body"), now);
      return commented.ok ? settle(commented.said) : answer(400, { ok: false, said: commented.message });
    }
    if (verb === "assign") {
      const assigned = assignFlowCard(store, target, body.get("owner") || null, who.name, now);
      return assigned.ok ? settle(assigned.said) : answer(400, { ok: false, said: assigned.message });
    }
    if (verb === "watch") return settle(watchFlowCard(store, target, who.name, body.get("watching") !== "no", now).ok ? body.get("watching") === "no" ? "You won't hear about this card unless someone mentions you." : "You'll hear about this card." : "Done.");
    const cancelled = cancelFlowCard(store, target, who.name, now);
    return cancelled.ok ? settle(cancelled.said) : answer(409, { ok: false, said: cancelled.message });
  };

  type TriggerVerb = "pause" | "resume" | "remove" | "check" | "press" | "renew" | "secret" | "share" | "unshare";
  const triggerAct = (verb: TriggerVerb) => async (ctx: HandlerContext): Promise<void> => {
    const { url, who } = ctx;
    const change = openFlowChange(ctx);
    if (change === null) return;
    const { body, now, answer, flow, dir, viewNow, settle } = change;
    const trigger = store.getFlowTrigger(Number(pathPart(url, 4)));
    if (trigger === null || trigger.flow !== flow.id || trigger.state === "removed") return answer(404, { ok: false, said: "That trigger isn't on this flow." });
    if (verb === "pause" || verb === "resume") { setFlowTriggerOn(store, trigger, verb === "resume", now); return settle(verb === "pause" ? "Trigger paused." : "Trigger on again."); }
    if (verb === "remove") { removeFlowTrigger(store, trigger, now, dir); return settle("Trigger removed."); }
    if (verb === "share") {
      const shared = shareFlowButton(store, trigger, now, dir);
      return shared.ok ? settle(shared.said, { reveal: shared.reveal }) : answer(409, { ok: false, said: shared.message });
    }
    if (verb === "unshare") { stopSharingFlowButton(store, trigger, now); return settle("The form link no longer works."); }
    if (verb === "press") {
      let answers: unknown;
      try { answers = JSON.parse(body.get("answers") ?? "[]"); } catch { answers = []; }
      const pressed = pressFlowButton(store, trigger, Array.isArray(answers) ? answers : [], who.name, now);
      return pressed.ok ? settle(pressed.said) : answer(400, { ok: false, said: pressed.message });
    }
    if (verb === "check") {
      const checked = await checkFlowTriggerNow(store, trigger, now, { gh: options.flowTriggerIo?.gh ?? execRun, fetch: options.flowTriggerIo?.fetch ?? fetch, dir, ...(options.flowTriggerIo?.mail === undefined ? {} : { mail: options.flowTriggerIo.mail }),
        // A schedule's script, run now (v90): in a clean folder beside the database, inside the agents' fence.
        shell: options.flowTriggerIo?.shell ?? execRun, scratch: options.flowTriggerIo?.scratch ?? join(dir ?? tmpdir(), "flow-scratch") });
      try { advanceFlows(store, flow.repo, now, { evidenceRoot }); } catch { /* the next worker pass retries */ }
      return answer(checked.ok ? 200 : 409, { ok: checked.ok, said: checked.said, view: viewNow() });
    }
    if (dir === null) return answer(409, { ok: false, said: "Webhook secrets are kept on the console's computer." });
    if (verb === "renew") {
      const renewed = renewFlowHook(store, trigger, now, dir);
      return renewed.ok ? settle(renewed.said, { reveal: renewed.reveal }) : answer(409, { ok: false, said: renewed.message });
    }
    // Linear's signing secret, pasted on this secure panel behind the password — never in chat.
    if (!authenticateApprover(who, body.get("password") ?? "").ok) return answer(403, { ok: false, said: "Enter your Toolroll password to save a secret." });
    const saved = saveLinearSigningSecret(trigger, body.get("secret") ?? "", dir);
    return saved.ok ? settle("Signing secret saved. Linear's deliveries can be proved now.") : answer(400, { ok: false, said: saved.message });
  };

  // ---- workflow recipes: changes ---------------------------------------------

  type RecipeStep = "prepare" | "preview" | "import" | "save" | "launch";
  const recipeAct = (step: RecipeStep) => async (ctx: HandlerContext): Promise<void> => {
    const { who, request, response, now, posted } = ctx;
    const body = readForm(posted, CONSOLE_FORMS.recipes);
    const project = projectOf(who, request);
    try {
      if (project === null || project === undefined || !visible(project)) throw new RecipeError("Open a project first.", 403);
      for (const field of ["repo", "projectRevision", "preview", "source", "sourceRevision", "document", "recipe", "recipeRevision", "purpose", "next"] as const) if (body.getAll(field).length > 1) throw new RecipeError(`Duplicated ${field} field.`);
      if (body.get("repo") !== project || (who.via === "cookie" && body.get("projectRevision") !== String(who.session.projectRevision))) throw new RecipeError("The open project changed. Reopen this recipe in the intended project.", 409);
      const rootMode = !unscopedMode && ceiling.roots.length > 0;
      if (rootMode && !(await authorizedProject(liveCeiling(), project))) throw new RecipeError("The project is outside this server's access.", 403);
      const rechecked = authorizeMutation(request, who, readForm(posted, CONSOLE_FORMS.mutationGuard));
      if (rechecked !== null) throw new RecipeError(rechecked.message, rechecked.status);
      if (projectOf(who, request) !== project) throw new RecipeError("The open project changed. Preview the intended project again.", 409);
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      if (step === "prepare") {
        const id = body.get("recipe") ?? "", version = body.get("recipeRevision") ?? "";
        if (!/^[1-9][0-9]{0,8}$/.test(version)) throw new RecipeError("Choose a valid recipe version.");
        const recipe = findRecipe(store, who.name, project, id, Number(version));
        if (recipe === null || recipe.repo === null) throw new RecipeError("This recipe is not available in this project.", 404);
        try {
          const preview = prepareRecipeRun(store, who.name, project, id, Number(version), recipeAnswersFromForm(body.sent), now);
          return redirect(response, `/recipes/preview?preview=${preview.token}`);
        } catch (error) {
          if (!(error instanceof RecipeError)) throw error;
          return sendScreen(response, error.status, screen("Use recipe", recipeRunHtml(recipe, project, revision, error.message, body.sent), { chrome: chromeFor(project, "recipes"), functional: { script: recipeScript() } }));
        }
      }
      if (step === "import") {
        const document = importRecipe(body.get("document") ?? "");
        return sendScreen(response, 200, screen("Imported recipe", recipeEditorHtml({ id: "imported", revision: 1, repo: project, document, digest: "", author: who.name }, project, revision, null, undefined, true), { chrome: chromeFor(project, "recipes"), functional: { script: recipeScript() } }));
      }
      if (step === "preview") {
        const purpose = body.get("purpose") ?? "workflow";
        if (!["recipe", "workflow"].includes(purpose)) throw new RecipeError("Choose preview recipe or preview workflow.");
        const source = body.get("source") ?? "custom";
        const sourceVersion = body.get("sourceRevision") ?? "1";
        if (!/^[1-9][0-9]{0,8}$/.test(sourceVersion)) throw new RecipeError("Choose a valid recipe version.");
        const original = ["custom", "imported", "task-copy"].includes(source) ? null : findRecipe(store, who.name, project, source, Number(sourceVersion));
        if (original === null && !["custom", "imported", "task-copy"].includes(source)) throw new RecipeError("That recipe version is not available in this project.", 404);
        let document;
        try { document = recipeFromForm(body.sent); }
        catch (error) {
          if (!(error instanceof RecipeError)) throw error;
          const fallback = original ?? { ...starterRecipes().find(one => one.id === "small-feature")!, id: source };
          return sendScreen(response, error.status, screen("Customize recipe", recipeEditorHtml(fallback, project, revision, error.message, body.sent, purpose === "recipe"), { chrome: chromeFor(project, "recipes"), functional: { script: recipeScript() } }));
        }
        const preview = createWorkflowPreview(store, who.name, project, document, source, now);
        return redirect(response, `/recipes/preview?preview=${preview.token}${purpose === "recipe" || document.version === 2 ? "&purpose=recipe" : ""}`);
      }
      const token = body.get("preview") ?? "";
      if (step === "save") {
        if (body.has("next") && body.get("next") !== "use") throw new RecipeError("Choose a valid recipe destination.");
        const saved = saveWorkflowRecipe(store, who.name, project, token, now);
        return redirect(response, body.get("next") === "use" ? `/recipes/run?recipe=${saved.id}&revision=${saved.revision}&saved=1` : `/recipes/preview?preview=${token}`);
      }
      const made = launchWorkflow(store, who.name, project, token, now, who.via === "cookie");
      if (rootMode) store.upsertProject(project, projectName(project), now);
      if (made.taskId !== null) {
        const context = requestContext.getStore(); if (context !== undefined) context.createdTask = made.taskId;
      }
      return redirect(response, made.taskId === null ? `/flows/${made.flowId}` : taskHref(made.taskId));
    } catch (error) {
      if (error instanceof RecipeError) return refuse(response, who, error.status, error.message, "/recipes");
      throw error;
    }
  };

  const registrations = handlersOf("flows", {
    "flows.new": newFlowGallery,
    "flows.gallery": galleryTemplatePage,
    "flows.page": flowsPage,
    "kits": kitsGallery,
    "kit.page": kitPage,
    "subagents": subagentsPage,
    "subagents.legacy": legacySubagentLink,
    "subagent.page": subagentPage,
    "subagent.soul-file": subagentSoulFile,
    "flow.insights": flowInsightsRead,
    "flow.run": flowRunRead,
    "flow.export": flowExportFile,
    "flow.page": flowPage,
    "recipes": recipeLibrary,
    "recipes.run": recipeScreen("run"),
    "recipes.start": recipeScreen("start"),
    "recipes.new": recipeScreen("new"),
    "recipes.edit": recipeScreen("edit"),
    "recipes.from-task": recipeScreen("from-task"),
    "recipes.preview": recipeScreen("preview"),
    "recipes.export": recipeScreen("export"),
    "recipes.other": recipeScreen("other"),
    "kit.setup": kitAct("setup"),
    "kit.sample": kitAct("sample"),
    "kit.github": kitAct("github"),
    "subagent.new": newSubagent,
    "subagent.soul": subagentAct("soul"),
    "subagent.state": subagentAct("state"),
    "subagent.note": subagentAct("note"),
    "subagent.settings": subagentAct("settings"),
    "subagent.summary": subagentAct("summary"),
    "subagent.tools": subagentAct("tools"),
    "subagent.memory": subagentAct("memory"),
    "subagent.routines": subagentAct("routines"),
    "subagent.week": subagentAct("week"),
    "subagent.answer": answerSubagentQuestionSend,
    "flows.gallery-create": createFromGallery,
    "flows.create": createFlow,
    "flows.example": createExampleFlow,
    "flows.import": importFlowFile,
    "flow.save": flowAct("save"),
    "flow.cards": flowAct("cards"),
    "flow.archive": flowAct("archive"),
    "flow.scripts": flowAct("scripts"),
    "flow.linear-key": flowAct("linear-key"),
    "flow.hooks-address": flowAct("hooks-address"),
    "flow.secrets": flowAct("secrets"),
    "flow.triggers": flowAct("triggers"),
    "flow.card.move": cardAct("move"),
    "flow.card.decide": cardAct("decide"),
    "flow.card.cancel": cardAct("cancel"),
    "flow.card.comment": cardAct("comment"),
    "flow.card.assign": cardAct("assign"),
    "flow.card.watch": cardAct("watch"),
    "flow.card.choose": cardAct("choose"),
    "flow.trigger.pause": triggerAct("pause"),
    "flow.trigger.resume": triggerAct("resume"),
    "flow.trigger.remove": triggerAct("remove"),
    "flow.trigger.check": triggerAct("check"),
    "flow.trigger.press": triggerAct("press"),
    "flow.trigger.renew": triggerAct("renew"),
    "flow.trigger.secret": triggerAct("secret"),
    "flow.trigger.share": triggerAct("share"),
    "flow.trigger.unshare": triggerAct("unshare"),
    "recipes.prepare-send": recipeAct("prepare"),
    "recipes.preview-send": recipeAct("preview"),
    "recipes.import-send": recipeAct("import"),
    "recipes.save-send": recipeAct("save"),
    "recipes.launch-send": recipeAct("launch"),
  });
  return { registrations, sendGalleryUse };
}
