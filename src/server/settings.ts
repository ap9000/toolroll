import { CONSOLE_FORMS,readForm } from "../contracts/console-api.js";
import { galleryTemplateOf } from "../flow-gallery.js";
import { finishGoogleConsent,GOOGLE_CALLBACK } from "../google-mail.js";
import { kitInstalled,kitOf } from "../kits.js";
import { CONNECT_CALLBACK,connectionsOf,finishConnect,localConnectOf,oneClickOf } from "../mcp-connect.js";
import { learningView } from "../project-learning.js";
import { skillTestResult } from "../project-skills.js";
import { discoverTools,projectToolsOf } from "../project-tools.js";
import { publishingOf } from '../pull-request-flow.js';
import { skillTestFeedbackHtml } from "../skills-ui.js";
import { nameOf } from "../teammate-admin.js";
import { grantTool } from "../teammate-tools.js";
import { learningHtml } from "../workspace-ui.js";
import { adapterPolicy } from "./route-policy.js";

import { createHash } from "node:crypto";
import { type IncomingMessage,type ServerResponse } from "node:http";
import { dirname,join } from "node:path";
import { INSTALLATION_SCOPE } from "../agentconfig.js";
import { rulesSummary } from "../approval-rules-ui.js";
import { installMethod } from "../install-method.js";
import { logEvent } from "../log.js";
import { modeTermsFromJson } from "../modes.js";
import { envValue } from "../names.js";
import { REMOTE_MESSAGES } from "../operate-remote.js";
import {
canonicalProject,
projectName
} from "../project.js";
import { ALL_CREDENTIAL_ENV,type ProviderId } from "../provider.js";
import { updateChecksOff } from "../releases.js";
import {
authenticateAccount
} from "../scope.js";
import { budgetLabel,monthOf } from "../spend.js";
import { PACKAGE_VERSION } from "../version.js";
import type { HandlerContext } from './handler-context.js';
import type { Registration } from './handler-registry.js';
import type { ServerRuntime } from './runtime.js';
import { escape,HANDOFF_STYLE,redirect,refuse,respond,safeReturn,screen,signInSpent,startedHere } from "./shared.js";
/** settings handlers, moved without changing their route bodies. */
import { DEFAULT_ACCENT,normalHex } from "../accent-colors.js";
import { resolvePhaseAgent } from "../agentconfig.js";
import { parseProtectedPaths } from "../approval-policy.js";
import { approvalRulesHtml } from "../approval-rules-ui.js";
import { backupHtml } from "../backup-ui.js";
import { BACKUP_EVERY_HOURS,backupFolderOf,backupNow,checkBackupFolder,defaultBackupFolder,MAX_KEEP } from "../backup.js";
import { projectBatchChecks,setProjectBatchChecks } from '../batch-policy.js';
import { ALL_PROJECTS as CHAT_APPROVAL_ALL,chatApprovalWords,setChatApproval } from "../chat-approval.js";
import { ChatState } from "../chat-delivery-state.js";
import { checkSettingsHtml } from '../check-levels-ui.js';
import { CHECK_LEVEL_WORDS,isCheckLevel,liveQuickCommand,projectCheckLevel,quickVerifyKey,setProjectCheckLevel,suggestQuickCommand } from '../check-levels.js';
import { checkoutPlan,cleanCheckouts,discardCheckout,previewDigest } from "../checkout-cleanup.js";
import { approveSetup,previewSetup,type SetupInputs } from "../control-setup.js";
import { connectionHtml,controlSetupHtml,hiddenFields,setupPreviewHtml } from "../control-ui.js";
import { hasDisguisedText } from '../decision.js';
import { checkDiscordCredentials,clearDiscordCredentials,DiscordError,loadDiscordCredentials,saveDiscordCredentials } from "../discord-api.js";
import { discordSettingsHtml } from "../discord-settings.js";
import { dataExportHtml } from "../export-ui.js";
import { buildExport,exportZip } from "../export.js";
import { firstResultWords } from "../first-run.js";
import { readEmailSettings,saveEmailSettings,sendingAccount,sendThroughServer } from "../flow-actions.js";
import { galleryHtml } from "../flow-gallery-ui.js";
import { startersHtml } from "../flow-starters-ui.js";
import { starterOf,startersFor,switchOnStarter } from "../flow-starters.js";
import { disconnectGoogle,googleConnected,googleConsent,readGoogleMail,saveGoogleClient } from "../google-mail.js";
import { integrationsHtml } from "../integrations-ui.js";
import { clearProviderKey,keyStatus,plausibleKey,PROVIDER_KEY_ENV,readAuthMode,readProviderKey,saveProviderKey,setAuthMode,SUBSCRIPTION_CAPABLE,verdictWords,verifyProviderKey,type AuthMode } from "../keys.js";
import { decisionsHtml,knowledgeHtml,MEMORY_INTRO,memorySearchHtml,proposalsHtml } from "../knowledge-ui.js";
import { aboutYouOf,checkAboutYou,saveAboutYou } from "../lead-about.js";
import { cancelCommitment,conditionWords,openCommitments } from '../lead-commitments.js';
import { checkLeadIdentity,leadIdentityOf } from "../lead-identity.js";
import { mailboxAccess,readThroughImap } from "../mailbox.js";
import { startConnect } from "../mcp-connect.js";
import { decideProposal,listProposals,memoryStatus } from "../memory-pass.js";
import { checkModels,isNewModel,modelOptions,modelWords,RUNTIME_TOOLS,runtimeStates,seenModels,setWatch,updateRuntime,watchState,type RuntimeTool } from "../model-catalog.js";
import { modelsHtml,modelsScript,type RoleView } from "../models-ui.js";
import { CHAT_APPROVE_ALL,MODE_MAX_DAYS,modeDigestOf,modeTermsJson,modeWords,presetTerms,type ModeName,type ModeTerms } from "../modes.js";
import { monitoringChange,readMonitoring,saveMonitoring } from "../monitoring-settings.js";
import { monitoringHtml,signingSecretHtml } from "../monitoring-ui.js";
import { openRouterPickerScript } from "../openrouter-models.js";
import { policyHtml } from "../policy-ui.js";
import { checkPolicy,parseList,policyParts } from "../policy.js";
import { parseProjectConcurrency,saveProjectConcurrency } from "../project-concurrency.js";
import { projectDeleteConfirmHtml,projectSettingsHtml } from "../project-delete-ui.js";
import { deleteProject,holdingsWords } from "../project-delete.js";
import { applySavedKnowledge,changeKnowledge,knowledgeVersion,knowledgeView,type KnowledgeDraft } from "../project-knowledge.js";
import { changeLearning } from "../project-learning.js";
import { listDecisions,recordDecision,retireDecision,searchMemory } from "../project-memory.js";
import { changeSkills,githubSkill,importSkill,reviseSkillTest,skillsView,testSkill,type SkillFile } from "../project-skills.js";
import { addToolTo,catalogTool,localAppOf,removeToolFrom,setToolSecret,splitCommandLine,testToolOf,type ToolSpec } from "../project-tools.js";
import { liftAuthPause } from "../provider-auth.js";
import { isProviderId,PROVIDER_IDS,validateSpec,validModelId } from "../provider.js";
import { checkPublishing,MERGE_METHODS,saveMergeSettings,savePublishing,type MergeMethod } from '../pull-request-flow.js';
import { pullRequestSettingsHtml } from '../pull-request-ui.js';
import { isQualityMode } from "../quality.js";
import { setUpdateChecks } from "../releases.js";
import { removeRepos,updateRepos } from "../repos.js";
import { repositoryContextHtml } from '../repository-context-ui.js';
import { repositoryContext,repositoryContextRead } from '../repository-context.js';
import { parseLimit,PER_DAY_MAX as REQUEST_BUDGET_PER_DAY_MAX,PER_MINUTE_MAX as REQUEST_BUDGET_PER_MINUTE_MAX,setLimitOverride,type LimitOverride } from "../request-budget.js";
import { retentionHtml } from "../retention-ui.js";
import { lastSweepAt,parsePeriod,periodChoices,RETENTION_KINDS,retentionPlan,type RetentionKind } from "../retention.js";
import { addProjectInstructions,ASSISTANTS,detectPreparation,modelChoices,previewProjectInstructions } from "../setup-guide.js";
import { skillsHtml,skillsScript } from "../skills-ui.js";
import { checkSlackCredentials,clearSlackCredentials,loadSlackCredentials,saveSlackCredentials,SLACK_MANIFEST,SlackError } from "../slack-api.js";
import { slackSettingsHtml } from "../slack-settings.js";
import { spendCsv,spendHtml } from "../spend-ui.js";
import { budgetStates,monthNamed,spendItems,usd as spendUsd,teammateNames as teammateNamesOf } from "../spend.js";
import { removeSsoSettings,saveSsoSettings,SSO_CALLBACK,ssoChangeWords } from "../sso-settings.js";
import { ssoSettingsHtml } from "../sso-ui.js";
import { lastSweep,saveSweep,storageSweepOff } from "../storage-sweep.js";
import { storageHtml } from "../storage-ui.js";
import { bytesWords,parseCleanup } from "../storage.js";
import { isDigestTime,RESULT_SCREENSHOTS,type ResultScreenshots } from "../store.js";
import { checkTeamsCredentials,clearTeamsCredentials,loadTeamsCredentials,saveTeamsCredentials,TeamsError } from "../teams-api.js";
import { teamsSettingsHtml } from "../teams-settings.js";
import { telegramSettingsHtml } from "../telegram-settings.js";
import { hashPairingCode,loadBotToken,mintPairingCode,PAIRING_TTL_MS,redactToken,saveBotToken } from "../telegram.js";
import { newerThan,updatesHtml,updatesScript,updateStepsHtml } from "../toolroll-update-ui.js";
import { abandonRuntimeUpdate,currentRuntime,launchRuntimeUpdate,markWhatsNewSeen,prepareRuntimeUpdate,releaseStalledUpdate,requestRuntimeUpdateCancel,runningWorkWords,runtimeUpdateStatus,runtimeUpdateTerminal,type When } from "../toolroll-update.js";
import { TOOLS_PROJECT_SCRIPT,toolsHtml,toolsProjectPicker } from "../tools-ui.js";
import { effectivePrimary,isMessagingChannel,savePrimary } from "../webhooks.js";
import type { EdgeContext } from './handler-context.js';
import { chatReturnWithSaid,goOutside,latestReleaseFor,leadSettingsHtml,notificationProjects,personChip,ROLE_TITLES,SETTINGS_AUTOSAVE_SCRIPT,settingsPage,settingsWorkers,telegramDeliveryWords,telegramTrouble,type LeadFormFacts } from "./shared.js";
export function createSettingsHandlers(runtime: ServerRuntime) {
  const { store, providerHome, managedRepos, consoleProjects, sendScreen, chromeFor, connectionCheck, clock, modelCatalog, modelSeams, toolsViewOf, codexServers, projectViewOf, sessions, restricted, options, integrations, consoleOrigin, evidenceRoot, storagePool, visible, ssoSettings, checkLocalAgents, chatKeyFor, chatCatalog, leadWords, agentSignInCommand, settingsUpdates, phoneSetup, authenticateApprover, deletedRepos, recordSignIn, projectOf, providerFor, admissionList, toolHome, connectVisits, mintApprovalNonce, consumeApprovalNonce, defaultProject, googleVisits } = runtime;

  async function get(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now, project, chosenProject, posted, route } = ctx;


    // v105: what agent work cost, by month, and the monthly budgets. An instance operator's page.
    if (url.pathname === "/spend") {
      if (!store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator sees spend.", "/");
      const current = monthOf(now);
      const asked = url.searchParams.get("month");
      const month = asked === null ? current : monthNamed(asked);
      if (month === null) return refuse(response, who, 400, "Choose a month like 2026-09.", "/spend");
      const items = spendItems(store.handle, month.from, month.to);
      const teammates = store.teammates([...new Set([...managedRepos(), ...store.knownRepos()])]);
      const teammateNames = teammateNamesOf(store.handle);
      if (url.searchParams.get("format") === "csv") {
        response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="standing-orders-spend-${month.name}.csv"`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return void response.end(spendCsv(items, teammateNames));
      }
      const shift = (by: number) => { const at = new Date(`${month.name}-01T00:00:00.000Z`); at.setUTCMonth(at.getUTCMonth() + by); return at.toISOString().slice(0, 7); };
      const projects = consoleProjects();
      const people = store.accountFacts().filter(one => one.revokedAt === null).map(one => one.name);
      const view = {
        month: month.name, previous: shift(-1), next: month.name === current.name ? null : shift(1),
        items, budgets: budgetStates(store.budgets(), items), teammateNames, csrf: who.via === "cookie" ? who.session.csrf : "",
        targets: [
          { value: "installation:*", label: "Everything", group: "Everything" as const },
          ...projects.map(repo => ({ value: `project:${repo}`, label: projectName(repo), group: "Projects" as const })),
          ...people.map(name => ({ value: `person:${name}`, label: name, group: "People" as const })),
          ...teammates.map(one => ({ value: `teammate:${one.id}`, label: `${teammateNames.get(one.id) ?? one.handle} (${projectName(one.repo)})`, group: "Teammates" as const })),
        ],
      };
      return sendScreen(response, 200, screen("Spend", spendHtml(view, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") }), { chrome: chromeFor(null, "spend") }));
    }

    if (url.pathname === "/mode") {
      if (project === null) {
        return refuse(response, who, 409, "open a project first — a mode is signed per repository");
      }
      const live = store.activeMode(project, now);
      const liveTerms = live === null ? null : modeTermsFromJson(live.termsJson);
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const hasGrant = store.hasMergeCapableGrant(project, now);
      const current =
        live === null || liveTerms === null
          ? `<div class="card"><h2>Locked</h2><p class="meta">No mode is signed — every action asks for your password. That is the default.</p></div>`
          : [
              `<div class="card">`,
              `<h2 style="margin-top:0">${escape(live.name)} <span class="meta">signed by ${personChip(live.signedBy)}</span></h2>`,
              modeWords(liveTerms)
                .map(words => `<p class="row">${escape(words)}</p>`)
                .join("\n"),
              who.role === "approver"
                ? `<form method="post" action="/mode/revoke" class="row">` +
                  `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
                  `<button type="submit">End this mode now</button>` +
                  `<span class="meta">one click — every act it covered falls back to its own ceremony</span></form>`
                : "",
              `</div>`,
            ].join("\n");
      const signForm =
        who.role !== "approver"
          ? ""
          : [
              `<div class="card">`,
              `<h2 style="margin-top:0">${live === null ? "sign a mode" : "replace it — a renewal is a new signature"}</h2>`,
              `<form method="post" action="/mode/confirm">`,
              `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
              `<label>Preset<select name="name"><option value="standard">standard — approvals stay with me</option><option value="hands-off">hands-off — your filings auto-approve, full permissions</option></select></label>`,
              `<label>Days <span class="meta">(1\u2013${MODE_MAX_DAYS})</span><input type="number" name="days" value="1" min="1" max="${MODE_MAX_DAYS}"></label>`,
              `<label>Merges<select name="publication">` +
                `<option value="notify">wait for me — even under a merge grant</option>` +
                (hasGrant ? `<option value="automerge">merge themselves when CI is green on the exact commit</option>` : "") +
                `</select></label>` +
                (hasGrant ? "" : `<span class="meta">self-merging needs a merge-capable publication grant first</span>`),
              `<label>My filings<select name="auto-approve">` +
                `<option value="">the preset's default (standard: wait for approval; hands-off: auto-approve)</option>` +
                `<option value="1">approve the moment I file them</option>` +
                `<option value="0">wait for their own approval</option>` +
                `</select></label>`,
              `<label>Planner approval<select name="plan-auto">` +
                `<option value="0">wait for my approval</option>` +
                `<option value="1">auto-approve plans that preserve my filed contract</option>` +
                `</select><span class="meta">Requires automatic filing approval. File the goal, paths, and acceptance criteria upfront. Changed scope and unanswered questions still pause.</span></label>`,
              `<label>From my chat app<select name="chat-approve">` +
                `<option value="">approve plans and merges here, with my password (the default)</option>` +
                `<option value="1">approve plans and merge ready pull requests from my paired chat, two taps each</option>` +
                `</select><span class="meta">Plans that widen permissions, exceed the attempt cap or touch protected paths still open Toolroll.</span></label>`,
              `<button type="submit">Read the full terms</button>`,
              `</form>`,
              `</div>`,
            ].join("\n");
      return sendScreen(
        response,
        200,
        screen("mode", [`<h1>Operating mode</h1><p>Authorize this project's automatic approvals once, for up to ${MODE_MAX_DAYS} days. Select the touchpoints below; the signature covers the exact choices. Existing modes keep their original terms.</p><p class="meta">Scope changes, agent questions, and requested revisions still require your attention. Automatic merging also needs a publication grant.</p>`, current, signForm].join("\n"), { chrome: chromeFor(project, "mode") }),
      );
    }

    if (url.pathname === "/control" || url.pathname === "/control/connection") {
      if (who.role !== "approver") return refuse(response, who, 403, "Project setup requires an approver.");
      if (project === null) return redirect(response, "/projects");
      const saved = store.phaseConfig(project, "build");
      const asked = url.searchParams.get("provider") ?? saved?.provider ?? "claude";
      if (!isProviderId(asked)) return refuse(response, who, 400, "Choose a known provider.", "/control");
      const task = url.searchParams.get("task") ?? "";
      const connection = await connectionCheck(asked, url.searchParams.get("check-connection") === "1");
      if (url.pathname === "/control/connection") {
        const command = asked === "claude" ? "claude auth login" : asked === "codex" ? "codex login" : asked === "gemini" ? "gemini" : null;
        return sendScreen(response, 200, screen(`${ASSISTANTS[asked].name} connection`, `<h1>${escape(ASSISTANTS[asked].name)} ${connection.state === "connected" ? "is connected" : "connection"}</h1>` +
          connectionHtml(asked, connection, task) + (command === null ? "" : `<p>On the computer running Toolroll, sign in with:</p><pre class="recap">${escape(command)}</pre>`) +
          `<p><a href="/settings#providers">Manage API keys and authentication mode</a></p>` + hiddenFields({ "resume-task": task }), { chrome: chromeFor(project, "settings") }));
      }
      const setup = store.liveWorktreeSetup(project);
      const preparation = detectPreparation(project);
      // The saved live catalog when it has models for this provider; the
      // built-in short list otherwise.
      const live = asked === "openrouter" ? [] : modelOptions(store, asked, clock(), providerHome).map(({ value, label }) => ({ value, label }));
      const configured = saved?.provider === asked ? saved.model : null;
      const models = live.length === 0 ? modelChoices(asked, configured, providerHome)
        : configured && !live.some(one => one.value === configured) ? [{ value: configured, label: `${configured} — current choice` }, ...live] : live;
      const instructions = previewProjectInstructions(project);
      const catalog = asked === "openrouter" ? await modelCatalog(readProviderKey("openrouter", providerHome), url.searchParams.get("refresh-models") === "1") : null;
      const inputs: SetupInputs = { provider: asked, model: saved?.provider === asked ? saved.model ?? "" : models[0]?.value ?? "", command: setup?.command ?? (saved === null ? preparation?.command ?? "" : ""), seconds: String((setup?.timeoutMs ?? 300_000) / 1000) };
      return sendScreen(response, 200, screen("Project setup", controlSetupHtml({ repo: project, csrf: who.via === "cookie" ? who.session.csrf : "", provider: asked, inputs, models, connection, catalog, task, preparation,
        instructions: instructions.ok ? { installed: instructions.installed } : { installed: false, message: instructions.message } }),
        { chrome: chromeFor(project, "settings"), ...(catalog === null ? {} : { functional: { script: openRouterPickerScript() } }) }));
    }
    if (url.pathname === "/settings/models") {
      const now = clock();
      const watch = watchState(store);
      // Opening the page refreshes a stale snapshot; the lists are public and
      // the check sends nothing about the person or their projects.
      if (who.role === "approver" && (watch.checkedAt === null || now.getTime() - Date.parse(watch.checkedAt) > 3_600_000)) {
        await checkModels(store, now, modelSeams).catch(() => undefined);
      }
      const view = modelsView(who.role === "approver", who.via === "cookie" ? who.session.csrf : "", now, url.searchParams.get("said"), url.searchParams.get("problem"));
      return sendScreen(response, 200, screen("Models", `<p><a href="/settings">Settings</a></p><h1>Models</h1>${modelsHtml(view)}`, { chrome: chromeFor(project, "settings"), functional: { script: modelsScript() } }));
    }
    if (url.pathname === "/settings/skills") {
      const projects = consoleProjects();
      const chosen = url.searchParams.get("repo") ?? project ?? projects[0] ?? "";
      if (chosen && !projects.includes(chosen)) return refuse(response,who,403,"That project is outside your access.","/projects");
      const selector = projects.length > 1 ? `<form class="skills" method="get"><label>Project<select name="repo">${projects.map(p=>`<option value="${escape(p)}"${p===chosen?' selected':''}>${escape(p.split('/').at(-1)??p)}</option>`).join('')}</select></label><button>Show project</button></form>` : '';
      let content = '<p>Add a project to manage its skills.</p>';
      if (chosen) {
        try { const agent=resolvePhaseAgent(store,'build',chosen,{});content = skillsHtml(skillsView(store,chosen,who.name),who.via==='cookie'?who.session.csrf:'',who.role==='approver',{focus:url.searchParams.get('skill')??'',agent:agent.ok?`Report agent: ${agent.spec.provider} · ${agent.spec.model??'default'}. Change it on the test task before approval`:'Choose a report agent on the test task before approval'}); }
        catch(error) { content = `<p class="problem" role="alert">${escape(error instanceof Error?error.message:'Skills are unavailable. Reload to retry.')}</p>`; }
      }
      return sendScreen(response,200,screen('Skills',`<p><a href="/settings">Settings</a></p><h1>Skills</h1>${url.searchParams.get('saved')==='1'?'<p role="status">Saved.</p>':''}${selector}${content}`,{chrome:chromeFor(chosen||project,'settings'),functional:{script:skillsScript()}}));
    }
    if (url.pathname === "/settings/tools") {
      const projects = consoleProjects();
      const chosen = url.searchParams.get("repo") ?? project ?? projects[0] ?? "";
      if (chosen && !projects.includes(chosen)) return refuse(response, who, 403, "That project is outside your access.", "/projects");
      const kit = kitOf(url.searchParams.get("kit") ?? "")?.id ?? null, wanted = (oneClickOf(url.searchParams.get("connect") ?? "") ?? localConnectOf(url.searchParams.get("connect") ?? ""))?.id ?? null;
      // Choosing a project opens it at once (keeping a kit's Connect), so every form below acts on the project shown.
      const selector = toolsProjectPicker(projects, chosen, { ...(kit === null ? {} : { kit }), ...(wanted === null ? {} : { connect: wanted }) });
      let content = "<p>Add a project to give its builds tools.</p>";
      if (chosen) {
        try {
          const approver = who.role === "approver" && who.via === "cookie";
          const view = toolsViewOf(chosen, approver ? await codexServers(chosen) : null, kit, wanted);
          if (approver) view.others = projects.filter(one => one !== chosen).map(one => ({ repo: one, project: projectName(one), open: connectionsOf(store, one).filter(c => c.state === "open").map(c => c.id) }));
          content = toolsHtml(view, who.via === "cookie" ? who.session.csrf : "", approver,
            { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") });
        } catch { content = '<p class="problem" role="alert">Tools are unavailable. Reload to retry.</p>'; }
      }
      return sendScreen(response, 200, screen("Tools", `<p><a href="/settings">Settings</a></p><h1>Tools</h1>${selector}${content}`, { chrome: chromeFor(chosen || project, "settings"), functional: { script: SETTINGS_AUTOSAVE_SCRIPT + TOOLS_PROJECT_SCRIPT } }));
    }
    // Settings → Project: what Toolroll holds for a project; an instance operator deletes it here.
    if (url.pathname === "/settings/project") {
      const projects = consoleProjects();
      const asked = url.searchParams.get("repo");
      const chosen = asked ?? (project != null && projects.includes(project) ? project : projects[0] ?? "");
      if (chosen && !projects.includes(chosen)) return refuse(response, who, 403, "That project is outside your access.", "/settings/project");
      const selector = projects.length > 1 ? `<form class="approval-project" method="get" action="/settings/project"><label>Project<select name="repo">${projects.map(p => `<option value="${escape(p)}"${p === chosen ? " selected" : ""}>${escape(projectName(p))}</option>`).join("")}</select></label><button>Show</button></form>` : "";
      const notice = { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") };
      const content = chosen === "" ? `${notice.said ? `<p role="status">${escape(notice.said)}</p>` : ""}<p>No projects yet.</p>` : projectSettingsHtml(projectViewOf(chosen, who), who.via === "cookie" ? who.session.csrf : "", notice);
      return sendScreen(response, 200, screen("Project", `<p><a href="/settings">Settings</a></p><h1>Project</h1>${selector}${content}`, { chrome: chromeFor(chosen || null, "settings") }));
    }
    // v102: Settings → Approval rules, a project's separation of duties. Anyone who sees the project reads them; an instance operator sets them.
    if (url.pathname === "/settings/approval") {
      const projects = consoleProjects();
      const chosen = url.searchParams.get("repo") ?? project ?? projects[0] ?? "";
      if (chosen && !projects.includes(chosen)) return refuse(response, who, 403, "That project is outside your access.", "/settings/approval");
      const selector = projects.length > 1 ? `<form class="approval-project" method="get" action="/settings/approval"><label>Project<select name="repo">${projects.map(p => `<option value="${escape(p)}"${p === chosen ? " selected" : ""}>${escape(projectName(p))}</option>`).join("")}</select></label><button>Show</button></form>` : "";
      const approvers = chosen === "" ? 0 : store.listApprovers().filter(one => { const account = store.accountOf(one.name); return account !== null && account.revokedAt === null && account.role === "approver" && store.accountCanAccess(one.name, chosen); }).length;
      const content = chosen === "" ? "<p>Add a project to set its approval rules.</p>" : approvalRulesHtml({ repo: chosen, name: projectName(chosen), rules: store.approvalRules(chosen), canChange: who.via === "cookie" && store.isInstanceOperator(who.name), approvers },
        who.via === "cookie" ? who.session.csrf : "", { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") });
      return sendScreen(response, 200, screen("Approval rules", `<p><a href="/settings">Settings</a></p><h1>Approval rules</h1>${selector}${content}`, { chrome: chromeFor(chosen || project, "settings") }));
    }
    // Sprint 8: Settings → Policy, the organisation policy and its history. Anyone signed in reads it; an instance operator changes it.
    if (url.pathname === "/settings/policy") {
      const repos = consoleProjects();
      const toolNames = [...new Set(repos.flatMap(repo => store.projectTools(repo).map(one => one.name)))].sort();
      const view = { policy: store.orgPolicy(), history: store.policyHistory(50), canChange: who.via === "cookie" && store.isInstanceOperator(who.name), toolNames };
      return sendScreen(response, 200, screen("Policy", `<p><a href="/settings">Settings</a></p><h1>Policy</h1>${policyHtml(view, who.via === "cookie" ? who.session.csrf : "", { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`,
        { chrome: chromeFor(project, "settings") }));
    }
    // Settings → Flows: the starter flows, each switched on with one yes. ?starter= marks the one a task's
    // "Do this every time…" asked about.
    if (url.pathname === "/settings/flows") {
      const projects = consoleProjects();
      const chosen = url.searchParams.get("repo") ?? project ?? projects[0] ?? "";
      if (chosen && !projects.includes(chosen)) return refuse(response, who, 403, "That project is outside your access.", "/settings");
      const content = chosen === "" ? "<p>Add a project to switch on starter flows.</p>" : startersHtml({
        repo: chosen, projects: projects.map(path => ({ path, name: projectName(path) })), starters: startersFor(store, chosen), csrf: who.via === "cookie" ? who.session.csrf : "",
        canSwitch: who.via === "cookie" && who.role === "approver" && !store.isDemo(), suggested: starterOf(url.searchParams.get("starter") ?? "")?.id ?? null,
        said: url.searchParams.get("said"), problem: url.searchParams.get("problem") }) +
        // Every template, beside the starters: Use this opens its page for this project.
        `<h2 class="gallery-heading">Templates</h2>${galleryHtml({ repo: chosen, canUse: who.via === "cookie" && who.role === "approver" && !store.isDemo(), connections: connectionsOf(store, chosen) })}`;
      return sendScreen(response, 200, screen("Flows", `<p><a href="/settings">Settings</a></p><h1>Flows</h1>${content}`, { chrome: chromeFor(chosen || project, "settings") }));
    }
    // Settings → Integrations: which integrations work. The list is the last checks; a render never waits on one.
    if (url.pathname === "/settings/integrations") {
      if (who.via !== "cookie" || who.role !== "approver" || restricted() || !options.configDir) return refuse(response, who, 403, "An installation approver sees integrations.", "/settings");
      const list = integrations.list();
      return sendScreen(response, 200, screen("Integrations", `<p><a href="/settings">Settings</a></p><h1>Integrations</h1>${integrationsHtml(list, who.session.csrf, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem"), checking: integrations.checking })}`,
        { chrome: chromeFor(project, "settings") }));
    }
    // v104: Settings → Monitoring, where the audit stream and traces go. An instance operator's page.
    if (url.pathname === "/settings/monitoring") {
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || !options.configDir) return refuse(response, who, 403, "An instance operator sets up monitoring.", "/settings");
      const view = { settings: readMonitoring(options.configDir), status: store.monitoringStatus(), head: store.ledgerHeadId(), origin: consoleOrigin(request.headers.host) };
      return sendScreen(response, 200, screen("Monitoring", `<p><a href="/settings">Settings</a></p><h1>Monitoring</h1>${monitoringHtml(view, who.session.csrf, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`,
        { chrome: chromeFor(project, "settings") }));
    }
    // Settings → Updates: the installed version, three ways to update, the update's steps live, then What's new. An instance operator's page.
    if (url.pathname === "/settings/updates") {
      const databaseFile = store.databaseFile();
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || databaseFile === null) return refuse(response, who, 403, "An instance operator updates Toolroll.", "/settings");
      // A record it cannot release is shown as it is; the page never fails over it.
      try { releaseStalledUpdate(dirname(databaseFile), clock()); } catch { /* shown as last saved */ }
      const status = runtimeUpdateStatus(dirname(databaseFile));
      if (url.searchParams.get("fragment") === "steps") return respond(response, 200, "text/html; charset=utf-8", status.journal ? updateStepsHtml(status.journal, status.running) : `<div id="update-live" data-done="1"></div>`);
      const active = status.journal !== null && !runtimeUpdateTerminal(status.journal.phase);
      const current = options.updates?.current ?? PACKAGE_VERSION;
      // While update checks are off the page asks npm nothing until Check now.
      const checksOff = updateChecksOff(process.env, options.configDir ?? dirname(databaseFile)).off && url.searchParams.get("check") !== "now";
      const view = { current, latest: active ? { version: current } : checksOff ? { off: true as const } : await latestReleaseFor(options.updates?.latest), method: options.updates?.method ?? installMethod(), journal: status.journal, running: status.running, whatsNew: status.whatsNew, rollbackTo: status.lastUpdate?.to === current ? status.lastUpdate.from : null, csrf: who.session.csrf };
      return sendScreen(response, 200, screen("Updates", `<p><a href="/settings">Settings</a></p><h1>Updates</h1>${updatesHtml(view, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`,
        { chrome: chromeFor(project, "settings"), ...(active ? { functional: { script: updatesScript(), fetches: true } } : {}) }));
    }
    // v105: Settings → Retention, how long each kind of data is kept. An instance operator's page.
    if (url.pathname === "/settings/retention") {
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator sets retention.", "/settings");
      const view = { periods: store.retentionPeriods(), chosen: Object.keys(store.retentionChosen()) as RetentionKind[], next: retentionPlan(store, evidenceRoot, now).counts, lastSweep: lastSweepAt(store), csrf: who.session.csrf };
      return sendScreen(response, 200, screen("Retention", `<p><a href="/settings">Settings</a></p><h1>Retention</h1>${retentionHtml(view, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`,
        { chrome: chromeFor(project, "settings") }));
    }
    // Settings → Storage: what task checkouts use, cleaning up now (the preview behind the password), and when a
    // finished task's clean checkout goes by itself. An instance operator's page.
    if (url.pathname === "/settings/storage") {
      const databaseFile = store.databaseFile();
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || databaseFile === null) return refuse(response, who, 403, "An instance operator looks after storage.", "/settings");
      const plan = await checkoutPlan(store, storagePool(databaseFile), now, { manual: true });
      const sweep = { last: lastSweep(store), off: storageSweepOff() };
      return sendScreen(response, 200, screen("Storage", `<p><a href="/settings">Settings</a></p><h1>Storage</h1>${storageHtml({ plan, csrf: who.session.csrf, sweep }, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`,
        { chrome: chromeFor(project, "settings") }));
    }
    // Settings → Projects → Pull requests: one project's setup. Off, the checks run on open, so the page says
    // exactly what turning on would do, or what to fix first.
    if (url.pathname === "/settings/pull-requests") {
      const repo = url.searchParams.get("repo") ?? "";
      const known = [...new Set([...managedRepos(), ...store.knownRepos(), ...store.listProjects().map(one => one.path)])];
      if (who.via !== "cookie" || !known.includes(repo) || !visible(repo)) return refuse(response, who, 404, "No such project.", "/projects");
      const publishing = publishingOf(store, repo);
      const canChange = who.role === "approver" && !store.isDemo();
      const check = publishing.on || !canChange ? null : await checkPublishing(repo, options.publishExec === undefined ? {} : { exec: options.publishExec });
      const html = pullRequestSettingsHtml({ repo, name: projectName(repo), csrf: who.session.csrf, canChange, publishing, check,
        said: url.searchParams.get("said"), problem: url.searchParams.get("problem") });
      return sendScreen(response, 200, screen("Pull requests", `<p><a href="/projects">Projects</a></p><h1>Pull requests</h1>${html}`, { chrome: chromeFor(project, "projects") }));
    }
    // Settings → Projects → Checks: how much checks after each build, and the quick command beside the full one.
    if (url.pathname === "/settings/checks") {
      const repo = url.searchParams.get("repo") ?? "";
      const known = [...new Set([...managedRepos(), ...store.knownRepos(), ...store.listProjects().map(one => one.path)])];
      if (who.via !== "cookie" || !known.includes(repo) || !visible(repo)) return refuse(response, who, 404, "No such project.", "/projects");
      const quick = liveQuickCommand(store, repo);
      const html = checkSettingsHtml({ repo, name: projectName(repo), csrf: who.session.csrf, canChange: who.role === "approver" && !store.isDemo(),
        level: projectCheckLevel(store, repo).level, full: store.liveVerifyCommand(repo), quick, suggestion: quick === null ? suggestQuickCommand(repo) : null,
        review: (({ on, source }) => ({ on, source }))(store.reviewSwitch(repo, clock())), batch: { on: projectBatchChecks(store, repo).on },
        said: url.searchParams.get("said"), problem: url.searchParams.get("problem") });
      return sendScreen(response, 200, screen("Checks", `<p><a href="/projects">Projects</a></p><h1>Checks</h1>${html}`, { chrome: chromeFor(project, "projects") }));
    }
    // Sprint 8: Settings → Backups, how the last backup went and the schedule. An instance operator's page.
    if (url.pathname === "/settings/backups") {
      const databaseFile = store.databaseFile();
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || databaseFile === null) return refuse(response, who, 403, "An instance operator looks after backups.", "/settings");
      const settings = store.backupSettings();
      const view = { settings, folder: backupFolderOf(settings, databaseFile), defaultFolder: defaultBackupFolder(databaseFile), runs: store.backupRuns(20), csrf: who.session.csrf, now };
      return sendScreen(response, 200, screen("Backups", `<p><a href="/settings">Settings</a></p><h1>Backups</h1>${backupHtml(view, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") })}`,
        { chrome: chromeFor(project, "settings") }));
    }
    // v105: Settings → Data, where an instance operator downloads everything. The download is a POST with the password.
    if (url.pathname === "/settings/data") {
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator exports data.", "/settings");
      return sendScreen(response, 200, screen("Data", `<p><a href="/settings">Settings</a></p><h1>Data</h1>${dataExportHtml(who.session.csrf, { problem: url.searchParams.get("problem") })}`,
        { chrome: chromeFor(project, "settings") }));
    }
    // v100: Settings → Sign-in, the identity provider people sign in with. An instance operator's page.
    if (url.pathname === "/settings/sign-in") {
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || !options.configDir) return refuse(response, who, 403, "An instance operator sets up sign-in.", "/settings");
      const origin = consoleOrigin(request.headers.host);
      const projects = consoleProjects().map(path => ({ path, name: projectName(path) }));
      const settings = ssoSettings();
      const html = ssoSettingsHtml({ settings, redirect: origin === null ? null : `${origin}${SSO_CALLBACK}`, projects, linked: settings !== null && store.ssoIdentitiesOf(who.name).some(one => one.issuer.replace(/\/+$/, "") === settings.issuer) },
        who.session.csrf, { said: url.searchParams.get("said"), problem: url.searchParams.get("problem") });
      return sendScreen(response, 200, screen("Sign-in", `<p><a href="/settings">Settings</a></p><h1>Sign-in</h1>${html}`, { chrome: chromeFor(project, "settings") }));
    }
    if (url.pathname === "/settings/knowledge") {
      const projects = consoleProjects();
      const chosen = url.searchParams.get("repo") ?? project ?? projects[0] ?? "";
      if (chosen && (!projects.includes(chosen) || !visible(chosen))) return refuse(response, who, 403, "That project is outside your access.", "/settings/knowledge");
      const selector = projects.length > 1 ? `<form class="knowledge" method="get" action="/settings/knowledge"><label>Project<select name="repo">${projects.map(p=>`<option value="${escape(p)}"${p===chosen?' selected':''}>${escape(p.split('/').at(-1)??p)}</option>`).join('')}</select></label><button>Show project</button></form>` : '';
      let content = '<p>Add a project to keep its knowledge here.</p>';
      if (chosen) {
        try {
          const csrf = who.via === 'cookie' ? who.session.csrf : '';
          const view = knowledgeView(store,chosen,who.name);
          if (url.searchParams.has('version')) {
            const revision=Number(url.searchParams.get('version'));
            const previous=knowledgeVersion(store,chosen,who.name,revision);
            const restore=csrf&&who.role==='approver'&&revision!==view.revision?`<form class="knowledge" method="post" action="/settings/knowledge/change">${hiddenFields({csrf,repo:chosen,identity:view.identity,revision:String(view.revision),action:'restore',restore:String(revision)})}<p>Replaces knowledge for future tasks. Existing runs keep their saved context.</p><button>Restore version ${revision}</button></form>`:'';
            return sendScreen(response,200,screen('Knowledge history',`<p><a href="/settings/knowledge?repo=${encodeURIComponent(chosen)}">Current knowledge</a></p><h1>Version ${revision}</h1>${knowledgeHtml({...view,knowledge:previous,history:[],stale:null},'',false)}${restore}`,{chrome:chromeFor(chosen,'settings')}));
          }
          const query = (url.searchParams.get('q') ?? '').slice(0, 1000);
          const result = query.trim() ? repositoryContextRead({ repo: chosen, query, mode: url.searchParams.get('mode') === 'impact' ? 'impact' : 'search', cacheRoot: join(dirname(evidenceRoot), 'repository-context') }) : null;
          const memoryQuery = (url.searchParams.get('memory') ?? '').slice(0, 300);
          const hits = memoryQuery.trim() ? searchMemory(store, { actor: who.name, repos: [chosen], query: memoryQuery, limit: 20 }) : null;
          let proposals = '';
          try { proposals = proposalsHtml(chosen, listProposals(store, chosen), memoryStatus(store, chosen, who.name), csrf, who.role === 'approver'); } catch { proposals = ''; }
          content = `<p class="meta">${MEMORY_INTRO}</p>` + memorySearchHtml(chosen, memoryQuery, hits) + proposals + decisionsHtml(chosen, listDecisions(store, chosen, who.name, { limit: 50 }), csrf, who.role === 'approver')
            + repositoryContextHtml(chosen, query, result, who.role === 'approver' ? csrf : '') + knowledgeHtml(view,csrf,who.role==='approver');
          content += `<details class="knowledge"><summary>Learned lessons</summary>${learningHtml(learningView(store,evidenceRoot,chosen,who.name),csrf,who.role==='approver')}</details>`;
        } catch { content = '<p class="problem" role="alert">Project knowledge is unavailable. Reload to retry.</p>'; }
      }
      return sendScreen(response,200,screen('Knowledge',`<p><a href="/settings">Settings</a></p><h1>Knowledge</h1>${url.searchParams.get('saved')==='1'?'<p role="status">Saved for future tasks.</p>':''}${selector}${content}`,{chrome:chromeFor(chosen||project,'settings')}));
    }
    if (url.pathname === "/settings/learning") {
      const projects = consoleProjects();
      const chosen = url.searchParams.get("repo") ?? project ?? projects[0] ?? "";
      if (chosen && (!projects.includes(chosen) || !visible(chosen))) return refuse(response, who, 403, "That project is outside your access.", "/settings/learning");
      const selector = `<form method="get" action="/settings/learning"><label>Project<select name="repo">${projects.map(p => `<option value="${escape(p)}"${p === chosen ? " selected" : ""}>${escape(p.split("/").at(-1) ?? p)}</option>`).join("")}</select></label><button>Show project</button></form>`;
      let content = "<p>No project is available.</p>";
      if (chosen) {
        try { content = learningHtml(learningView(store, evidenceRoot, chosen, who.name, Math.max(0, Number(url.searchParams.get("before")) || 0)), who.via === "cookie" ? who.session.csrf : "", who.role === "approver"); }
        catch { content = '<p class="problem" role="alert">Learning is unavailable. Reload to retry. Task results are unchanged.</p>'; }
      }
      return sendScreen(response, 200, screen("Learning", `<p><a href="/settings">Settings</a></p><h1>Learning</h1>${selector}${content}`, { chrome: chromeFor(chosen || project, "settings") }));
    }
    // Settings → Lead (onboarding): what runs the lead in one line, and the full form under Advanced.
    if (url.pathname === "/settings/lead") {
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver sets up the lead.", "/settings");
      if (runtime.localSignIn === null) await Promise.race([checkLocalAgents(), new Promise(done => setTimeout(done, 6_000).unref?.())]);
      const config = store.getChatConfig();
      const facts: LeadFormFacts = {
        keyFacts: (["anthropic-api", "openrouter-api"] as const).map(one => {
          const found = chatKeyFor(one);
          return { provider: one, state: found === null ? "none" : found.source, tail: found === null || found.source === "environment" ? null : redactToken(found.key) };
        }),
        openrouterModels: (await chatCatalog())?.map(one => one.id) ?? null,
        liveModels: [...modelOptions(store, "claude", now, providerHome), ...modelOptions(store, "codex", now, providerHome)],
        csrf: who.session.csrf,
        returnTo: "/settings/lead",
      };
      const signedIn = runtime.localSignIn?.states.claude === "connected" ? "Claude Code" : runtime.localSignIn?.states.codex === "connected" ? "Codex" : null;
      const promises = openCommitments(store, who.name, 50).map(one => ({ id: one.id, what: one.what, when: conditionWords(store, one.condition), until: one.expiresAt }));
      return sendScreen(response, 200, screen("Lead", leadSettingsHtml({ config, facts, words: leadWords(), signedIn, command: agentSignInCommand(),
        said: url.searchParams.get("said"), saved: url.searchParams.get("saved") === "1", identity: leadIdentityOf(store, who.name), promises,
        about: aboutYouOf(store, who.name), aboutSaved: url.searchParams.get("saved") === "about" }), { chrome: chromeFor(project, "settings") }));
    }
    if (url.pathname === "/settings/telegram") {
      // Any approver pairs their OWN phone here; the bot token stays on /settings.
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver can pair their own phone.", "/settings");
      const botId = options.telegramTokenFile === undefined ? null : loadBotToken(process.env, options.telegramTokenFile)?.botId ?? null;
      // The settings view holds no secret (a pairing code only appears in
      // the response to Pair, which stays script-free), so it joins the
      // workspace like every other settings page.
      return sendScreen(response, 200, screen("Telegram", telegramSettingsHtml(store, botId, who.name, who.session.csrf, { now }), { chrome: chromeFor(project, "settings") }));
    }
    if (url.pathname === "/settings/teams") {
      if (who.via !== "cookie" || who.role !== "approver" || restricted() || !options.configDir) return refuse(response, who, 403, "An installation approver can connect Teams.", "/settings");
      return sendScreen(response, 200, screen("Teams", teamsSettingsHtml(store, options.configDir, who.session.csrf, { who: who.name, publicUrl: options.publicUrl ?? null }), { chrome: chromeFor(project, "settings") }));
    }
    if (url.pathname === "/settings/discord") {
      if(who.via!=="cookie"||who.role!=="approver"||restricted()||!options.configDir) return refuse(response,who,403,"An installation approver can connect Discord.","/settings");
      return sendScreen(response,200,screen("Discord",discordSettingsHtml(store,options.configDir,who.session.csrf,{who:who.name}),{chrome:chromeFor(project,"settings")}));
    }
    if (url.pathname === "/settings/slack" || url.pathname === "/settings/slack/manifest") {
      if (who.via !== "cookie" || who.role !== "approver" || restricted() || !options.configDir) return refuse(response,who,403,"An installation approver can connect Slack.","/settings");
      if (url.pathname.endsWith("/manifest")) {
        response.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Content-Disposition":'attachment; filename="standing-orders-slack.json"',"Cache-Control":"no-store"});
        response.end(JSON.stringify(SLACK_MANIFEST,null,2));return;
      }
      return sendScreen(response,200,screen("Slack",slackSettingsHtml(store,options.configDir,who.session.csrf,{who:who.name}),{chrome:chromeFor(project,"settings")}));
    }

    if (url.pathname === "/settings" && (options.telegramTokenFile === undefined || restricted())) {
      return sendScreen(response, 200, screen("Settings", '<h1>Settings</h1><p><a href="/settings/models">Models</a> · <a href="/settings/skills">Skills</a> · <a href="/settings/tools">Tools</a> · <a href="/settings/knowledge">Project knowledge</a> · <a href="/settings/telegram">Telegram</a></p><details><summary>Learning history</summary><a href="/settings/learning">Learning</a></details>', { chrome: chromeFor(project, "settings") }));
    }

    if (url.pathname === "/settings" && options.telegramTokenFile !== undefined) {
      const existing = loadBotToken({}, options.telegramTokenFile);
      const hasEnv = (envValue(process.env, "TELEGRAM_TOKEN") ?? "") !== "";
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const messaging =
        options.configDir === undefined
          ? null
          : effectivePrimary(process.env, options.configDir, loadBotToken(process.env, options.telegramTokenFile) !== null);
      const push = {
        // The card lights only where a secure context exists: the stated
        // public origin, or localhost development (arc 3 finding 2).
        available: options.publicUrl !== undefined || (request.headers.host ?? "").startsWith("localhost") || (request.headers.host ?? "").startsWith("127.0.0.1"),
        devices: who.via === "cookie" ? store.listPushSubscriptions(who.name) : [],
      };
      const providerKeys = who.role !== "approver"
        ? null
        : await Promise.all(PROVIDER_IDS.map(async provider => ({
            provider,
            envName: PROVIDER_KEY_ENV[provider as "claude"],
            ...keyStatus(provider, providerHome),
            connection: await connectionCheck(provider, url.searchParams.get("check-connection") === provider),
            ambient: (process.env[PROVIDER_KEY_ENV[provider as "claude"]] ?? "") !== "",
            mode: readAuthMode(provider, providerHome),
            subscriptionCapable: SUBSCRIPTION_CAPABLE[provider],
          })));
      const telegramConfigured = loadBotToken(process.env, options.telegramTokenFile) !== null;
      const digest = telegramConfigured
        ? (() => {
            const cadence = store.telegramDigest();
            return { everyMs: cadence.everyMs, lastSentAt: cadence.lastSentAt, held: store.countRoutinePending() };
          })()
        : null;
      return sendScreen(
        response,
        200,
        settingsPage(chromeFor(project, "settings"), existing, hasEnv, csrf, url.searchParams.get("said"), messaging, push, providerKeys, digest, {
          ...store.permissionDefault(),
          canManage: who.role === "approver",
        }, {
          ...store.qualityDefault(),
          canManage: who.role === "approver",
        }, who.role === "approver" && csrf !== "" ? (() => {
          // v87: the mail server flows send email through; the password is never shown back.
          // v89: where Inbox triggers read it, and a connected Google account (its client secret is never shown back either).
          const email = readEmailSettings(options.configDir ?? null), google = readGoogleMail(options.configDir ?? null), origin = consoleOrigin(request.headers.host);
          const googleView = { connected: googleConnected(options.configDir ?? null)?.address ?? null, clientId: google?.clientId ?? "", redirect: origin === null ? null : `${origin}${GOOGLE_CALLBACK}` };
          return email === null ? { set: false, host: "", port: 587, secure: false, user: "", from: "", imapHost: "", imapPort: 993, google: googleView }
            : { set: true, host: email.host, port: email.port, secure: email.secure, user: email.user, from: email.from, imapHost: email.imap?.host ?? "", imapPort: email.imap?.port ?? 993, google: googleView };
        })() : null, telegramDeliveryWords(store, loadBotToken(process.env, options.telegramTokenFile)), settingsWorkers(store, now), settingsUpdates(who.name, csrf), (() => {
          // The installation fact: when the first Ready result arrived, measured from the first account.
          const at = store.firstSuccessAt(now), since = store.installationStartedAt();
          return at === null || since === null ? null : firstResultWords(since, at);
        })(), (() => {
          const chosen = store.notificationPreference(who.name);
          return { mode: chosen.mode, digestAt: chosen.digestAt, screenshots: chosen.screenshots, projects: notificationProjects(store, who.name) };
        })(), telegramTrouble(store, loadBotToken(process.env, options.telegramTokenFile)), who.via === "cookie" ? phoneSetup(who) ?? null : null),
      );
    }
    return refuse(response, who!, 404, "There's no page at this address.", "/chat");
  }

  async function post(ctx: HandlerContext): Promise<void> {
    const { url, who, request, response, now, project, chosenProject, posted, route } = ctx;

    // A person says a provider's sign-in works again: its sign-in pause
    // lifts, its tasks may start, and one short message says so.
    const resumeProvider = /^\/providers\/([a-z]+)\/resume$/.exec(url.pathname);
    if (resumeProvider !== null) {
      const provider = resumeProvider[1]!;
      if (!isProviderId(provider)) return refuse(response, who, 400, "unknown provider", "/work");
      if (who.role !== "approver") return refuse(response, who, 403, "Only an operator can resume an agent's work.", "/work");
      liftAuthPause(store, provider, "person", who.name, clock());
      return redirect(response, "/work");
    }
    // The update notice is dismissed per browser and per version: a newer release shows it again.
    if (url.pathname === "/settings/updates/dismiss") {
      const body = readForm(posted, CONSOLE_FORMS.updatesDismiss);
      const version = body.get("version") ?? "";
      if (!/^[0-9A-Za-z.-]{1,60}$/.test(version)) return refuse(response, who, 400, "Choose a version to dismiss.", "/settings#updates");
      response.setHeader("Set-Cookie", `so-update-seen=${version}; SameSite=Lax; Path=/; Max-Age=31536000`);
      if (body.get("quiet") === "1") { response.writeHead(204); response.end(); return; }
      return redirect(response, safeReturn(body.get("return") ?? "/settings#updates"));
    }
    // The daily check's switch: an installation setting, so an operator's. (Its own address: POST /settings/updates starts an update.)
    if (url.pathname === "/settings/updates/checks") {
      const body = readForm(posted, CONSOLE_FORMS.updatesChecks);
      if (options.configDir === undefined) return refuse(response, who, 404, "Updates are not set up on this console.", "/settings");
      if (!store.isInstanceOperator(who.name)) return refuse(response, who, 403, "Only an operator can change update checks.", "/settings#updates");
      const on = body.get("check") === "on";
      setUpdateChecks(options.configDir, on);
      return redirect(response, `/settings?said=${encodeURIComponent(on ? "Toolroll looks for a newer version once a day." : "Update checks are off.")}#updates`);
    }

    if (url.pathname === "/settings/skills/revise") {
      const body = readForm(posted, CONSOLE_FORMS.skillsRevise);
      if(who.via!=='cookie'||who.role!=='approver')return refuse(response,who,403,'Sign in to revise a test.','/settings/skills');
      try {
        const run=Number(body.get('run')),source=skillTestResult(store,run,who.name);
        if(!source||!visible(source.repo)||body.get('repo')!==source.repo||(['run','repo','nonce','feedback'] as const).some(k=>body.getAll(k).length!==1))return refuse(response,who,403,'That skill test is outside your access.','/settings/skills');
        try{const revision=reviseSkillTest(store,{run,actor:who.name,feedback:body.get('feedback')??'',nonce:body.get('nonce')??''},clock());return redirect(response,`/t/${encodeURIComponent(revision.id)}`);}
        catch(error){return sendScreen(response,409,screen('Revise skill test',skillTestFeedbackHtml(source,who.session.csrf,true,error instanceof Error?error.message:'The test could not be created.',body.get('feedback')??''),{chrome:chromeFor(source.repo,'settings')}));}
      } catch {return refuse(response,who,409,'The source test could not be verified. Open its result and try again.','/settings/skills');}
    }
    if (url.pathname === "/settings/skills/import" || url.pathname === "/settings/skills/change") {
      const body = readForm(posted, CONSOLE_FORMS.skillsChange);
      if (who.via !== 'cookie' || who.role !== 'approver') return refuse(response,who,403,'Sign in as an approver to manage skills.','/settings/skills');
      const repo=body.get('repo')??'',back=`/settings/skills?repo=${encodeURIComponent(repo)}`;
      if (!visible(repo)||!consoleProjects().includes(repo)) return refuse(response,who,403,'That project is outside your access.','/projects');
      if ([...new Set(body.keys())].some(k=>body.sent.getAll(k).length!==1)) return refuse(response,who,400,'Invalid skills form.',back);
      try {
        const view=skillsView(store,repo,who.name);
        if(body.get('identity')!==view.identity||body.get('revision')!==String(view.revision)) throw Error('Skills changed in another window. Review the current selection and try again.');
        if(url.pathname.endsWith('/import')) {
          const method=body.get('method');let files:SkillFile[],source:string;
          if(method==='paste'){files=[{path:'SKILL.md',base64:Buffer.from(body.get('content')??'').toString('base64')}];source='Pasted SKILL.md';}
          else if(method==='folder'){files=JSON.parse(body.get('files')??'[]') as SkillFile[];source='Uploaded local folder';}
          else if(method==='github'){const imported=await githubSkill(body.get('url')??'');files=imported.files;source=imported.source;}
          else throw Error('Choose how to add the skill.');
          const skill=importSkill(store,repo,who.name,files,source,clock());return redirect(response,`${back}&skill=${skill.sha}#skill-${skill.sha}`);
        }
        const action=body.get('action');
        if(action==='test'){const task=testSkill(store,{repo,actor:who.name,sha:body.get('sha')??'',sample:body.get('sample')??'',nonce:body.get('nonce')??''},clock());return redirect(response,`/t/${encodeURIComponent(task.id)}`);}
        if(action!=='enable'&&action!=='disable'&&action!=='restore')throw Error('Choose a supported skills action.');
        changeSkills(store,{repo,actor:who.name,identity:view.identity,revision:view.revision,action,sha:body.get('sha')??'',restore:Number(body.get('restore'))},clock());
        return redirect(response,`${back}&saved=1`);
      } catch(error) {
        const message=error instanceof Error?error.message:'Skills could not be saved. Try again.';
        let content=`<p role="alert">${escape(message)}</p><a href="${escape(back)}">Reload Skills</a>`;
        try {content=skillsHtml(skillsView(store,repo,who.name),who.session.csrf,true,{error:message,draft:Object.fromEntries((['method','content','url','sample','sha'] as const).map(k=>[k,body.get(k)??'']))});}catch{/* Do not display unverified packages. */}
        return sendScreen(response,409,screen('Skills',`<h1>Skills</h1>${content}`,{chrome:chromeFor(repo,'settings'),functional:{script:skillsScript()}}));
      }
    }
    // v103: an instance operator records a checkpoint of the ledger chain (its head, to copy off the machine).
    // v105: set or remove a monthly budget. An instance operator, with a step-up; the ledger keeps before → after.
    if (url.pathname === "/spend/budget") {
      const body = readForm(posted, CONSOLE_FORMS.spendBudget);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator sets budgets.", "/spend");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/spend?${key}=${encodeURIComponent(words)}`);
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "Enter your Toolroll password to change a budget.");
      const target = /^(installation|project|person|teammate):(.+)$/.exec(body.get("target") ?? "");
      if (target === null) return back("problem", "Choose what the budget is for.");
      const scope = target[1] as "installation" | "project" | "person" | "teammate", key = target[2]!;
      const known = scope === "installation" ? key === "*"
        : scope === "project" ? consoleProjects().includes(key)
        : scope === "person" ? store.accountFacts().some(one => one.name === key && one.revokedAt === null)
        : store.teammates([...new Set([...managedRepos(), ...store.knownRepos()])]).some(one => String(one.id) === key);
      if (!known) return back("problem", "That isn't a project, person or teammate here.");
      const label = budgetLabel({ scope, key }).replace(/'s$/, "");
      if (body.get("action") === "remove") {
        const existing = store.budgets().find(one => one.scope === scope && one.key === key);
        if (existing === undefined || !store.removeBudget(existing.id, who.name, now)) return back("problem", "That budget is already gone.");
        return back("said", `${label}: budget removed.`);
      }
      const dollars = Number(body.get("usd") ?? "");
      if (!Number.isFinite(dollars) || dollars < 1 || dollars > 10_000_000) return back("problem", "A monthly limit is a whole number of dollars, at least $1.");
      const saved = store.setBudget({ scope, key, limitMicrousd: Math.round(dollars) * 1_000_000, hardStop: body.get("stop") === "1" }, who.name, now);
      return back("said", `${label}: ${spendUsd(saved.limitMicrousd)} a month${saved.hardStop ? ", API work stops at 100%" : ", alerts only"}.`);
    }
    // Delete a project, in two steps: its name, then what goes and the password. An instance operator; the ledger keeps who and what.
    // Settings → Project → Builds at once: an approver for the project sets it; the ledger keeps before → after.
    if (url.pathname === "/settings/project/concurrency") {
      const body = readForm(posted, CONSOLE_FORMS.projectConcurrency);
      const repo = body.get("repo") ?? "";
      const known = consoleProjects();
      if (!known.includes(repo)) return refuse(response, who, 403, "That project is outside your access.", "/settings/project");
      if (who.via !== "cookie" || who.role !== "approver" || !store.accountCanAccess(who.name, repo)) return refuse(response, who, 403, "An approver for this project sets how many tasks build at once.", "/settings/project");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/project?repo=${encodeURIComponent(repo)}&${key}=${encodeURIComponent(words)}`);
      const n = parseProjectConcurrency(body.get("concurrency") ?? "");
      if (n === null) return back("problem", "Builds at once is a whole number from 1 to 64. Nothing changed.");
      const databaseFile = store.databaseFile();
      if (databaseFile === null) return back("problem", "This database keeps no settings files. Nothing changed.");
      const changed = saveProjectConcurrency(databaseFile, repo, n);
      store.recordProjectConcurrency(who.name, repo, changed.before, changed.after, now);
      store.bumpWake();
      return back("said", changed.before === changed.after ? "Nothing changed." : `Saved. Up to ${n} at once.`);
    }
    if (url.pathname === "/settings/project/delete") {
      const body = readForm(posted, CONSOLE_FORMS.projectDelete);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator deletes projects.", "/settings/project");
      const repo = body.get("repo") ?? "";
      const known = consoleProjects();
      if (!known.includes(repo)) return refuse(response, who, 403, "That project is outside your access.", "/settings/project");
      const back = (key: "said" | "problem", words: string, to = repo) => redirect(response, `/settings/project?${to === "" ? "" : `repo=${encodeURIComponent(to)}&`}${key}=${encodeURIComponent(words)}`);
      const view = projectViewOf(repo, who);
      if ((body.get("name") ?? "").trim() !== view.name) return back("problem", `Type ${view.name} exactly to delete it.`);
      const confirm = (problem: string | null) => sendScreen(response, 200, screen(`Delete ${view.name}?`, `<p><a href="/settings/project?repo=${escape(encodeURIComponent(repo))}">${escape(view.name)}</a></p><h1>Delete ${escape(view.name)}?</h1>${projectDeleteConfirmHtml(view, who.session.csrf, problem)}`,
        { chrome: chromeFor(repo, "settings"), forceSensitive: true }));
      if (view.running.length > 0) return back("problem", `Nothing was deleted: ${view.running.join(", ")}. Stop it, then try again.`);
      if (body.get("step") !== "delete") return confirm(null);
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return confirm("That password didn't match. Nothing was deleted.");
      const done = await deleteProject(store, repo, { actor: who.name, via: "console", now, evidenceRoot, poolRoot: options.poolRoot ?? null });
      if (!done.ok) return back("problem", done.said);
      if (options.registryPath !== undefined) await updateRepos(options.registryPath, repos => removeRepos(repos, [repo])).catch(() => undefined);
      deletedRepos.add(repo);
      if (who.session.project === repo) { who.session.project = null; who.session.projectRevision += 1; sessions.persist(who.session); }
      return back("said", `Deleted ${view.name}: ${holdingsWords(done.removed)}.${done.left.length > 0 ? ` Git kept ${done.left.length === 1 ? "one item" : `${done.left.length} items`}: ${done.left.join("; ")}.` : ""}`, "");
    }
    // Sprint 8: an instance operator saves the organisation policy, with a step-up; the ledger keeps each rule's before → after.
    if (url.pathname === "/settings/policy") {
      const body = readForm(posted, CONSOLE_FORMS.policy);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator sets the policy.", "/settings/policy");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/policy?${key}=${encodeURIComponent(words)}`);
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "That password didn't match. Nothing changed.");
      const chosen = body.getAll("provider");
      const checked = checkPolicy({ providers: chosen.length === 4 ? null : chosen, models: parseList(body.get("models")), tools: parseList(body.get("tools")), ceiling: body.get("ceiling") ?? "" });
      if (!checked.ok) return back("problem", `${checked.problem} Nothing changed.`);
      const before = policyParts(store.orgPolicy());
      const after = policyParts(store.setOrgPolicy(checked.policy, who.name, now));
      const same = (Object.keys(before) as (keyof typeof before)[]).every(rule => before[rule] === after[rule]);
      return back("said", same ? "Nothing changed." : "Policy saved.");
    }
    // v102: an instance operator changes a project's approval rules, with a step-up; the ledger keeps before → after.
    if (url.pathname === "/settings/approval") {
      const body = readForm(posted, CONSOLE_FORMS.approval);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator sets approval rules.", "/settings/approval");
      const repo = body.get("repo") ?? "";
      const known = consoleProjects();
      if (!known.includes(repo)) return refuse(response, who, 403, "That project is outside your access.", "/settings/approval");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/approval?repo=${encodeURIComponent(repo)}&${key}=${encodeURIComponent(words)}`);
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "That password didn't match. Nothing changed.");
      const protect = body.get("protect") ?? "none";
      const paths = parseProtectedPaths(body.get("paths") ?? "");
      if (!paths.ok) return back("problem", paths.problem);
      if (protect === "paths" && paths.paths.length === 0) return back("problem", "List at least one path to protect, or protect the whole project.");
      const next = { notRequester: body.get("not_requester") === "1", protectProject: protect === "project", protectedPaths: protect === "paths" ? paths.paths : [] };
      store.setApprovalRules(repo, next, who.name, now);
      return back("said", `Saved. ${rulesSummary(next)}`);
    }
    // v112: request limits for API tokens (request-budget.ts). An instance operator, in a browser, with their password;
    // never over /api/cli or /mcp (a token never reaches a console form).
    if (url.pathname === "/settings/request-limits") {
      const body = readForm(posted, CONSOLE_FORMS.requestLimits);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator sets request limits.", "/settings/sessions");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/sessions?${key}=${encodeURIComponent(words)}`);
      const target = body.get("target") ?? "";
      const token = target === "*" ? null : store.apiTokens(null).find(one => one.id === target && one.revokedAt === null) ?? null;
      if (target !== "*" && token === null) return back("problem", "That token is no longer live. Nothing changed.");
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "Enter your Toolroll password to change request limits.");
      const read = (name: "read-per-minute" | "act-per-minute" | "per-minute" | "per-day") => parseLimit(body.get(name) ?? "", name === "per-day" ? REQUEST_BUDGET_PER_DAY_MAX : REQUEST_BUDGET_PER_MINUTE_MAX);
      const clear = body.get("action") === "clear";
      const fields = clear ? { readPerMinute: null, actPerMinute: null, perDay: null }
        : token === null ? { readPerMinute: read("read-per-minute"), actPerMinute: read("act-per-minute"), perDay: read("per-day") }
        : { readPerMinute: token.access === "read" ? read("per-minute") : null, actPerMinute: token.access === "act" ? read("per-minute") : null, perDay: read("per-day") };
      const problem = Object.values(fields).find((value): value is { problem: string } => value !== null && typeof value === "object");
      if (problem !== undefined) return back("problem", `${problem.problem} Nothing changed.`);
      setLimitOverride(store, target, fields as LimitOverride, who.name, now);
      const label = token === null ? "Everyone's tokens" : token.name;
      return back("said", clear || Object.values(fields).every(value => value === null) ? `${label}: default limits.` : `${label}: limits saved.`);
    }
    if (url.pathname === "/settings/sign-in") {
      const body = readForm(posted, CONSOLE_FORMS.signIn);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || !options.configDir) return refuse(response, who, 403, "An instance operator sets up sign-in.", "/settings");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/sign-in?${key}=${encodeURIComponent(words)}`);
      const action = body.get("action") ?? "";
      const before = ssoSettings();
      if (action === "test") {
        if (before === null) return back("problem", "Sign-in with a provider isn't set up.");
        runtime.ssoProvider = null;
        const found = await providerFor(before.issuer);
        return found.ok ? back("said", `${before.label} answers: it's ready for people to sign in.`) : back("problem", found.said);
      }
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "Enter your Toolroll password to change sign-in.");
      if (action === "remove") {
        removeSsoSettings(options.configDir);
        runtime.ssoProvider = null;
        store.recordAction({ at: now.toISOString(), actor: who.name, repo: null, taskId: null, runId: null, action: "sign-in with a provider turned off", outcome: "changed", source: "policy", detail: ssoChangeWords(before, null) });
        return back("said", "Sign-in with the provider is off. Passwords work for everyone again.");
      }
      if (action !== "save") return back("problem", "Choose a sign-in action.");
      const rules = [];
      for (let index = 0; index < 50 && body.has(`group-${index}`); index++) rules.push({ group: body.get(`group-${index}`) ?? "", role: body.get(`role-${index}`) ?? "", projects: body.getAll(`projects-${index}`) });
      const saved = saveSsoSettings(options.configDir, { issuer: body.get("issuer") ?? "", clientId: body.get("client-id") ?? "", clientSecret: body.get("client-secret") ?? "", label: body.get("label") ?? "",
        scopes: body.get("scopes") ?? "", groupsClaim: body.get("groups-claim") ?? "", passwords: body.get("passwords") ?? "", rules }, before);
      if (!saved.ok) return back("problem", saved.said);
      // The provider has to answer before anyone depends on it.
      runtime.ssoProvider = null;
      const found = await providerFor(saved.settings.issuer);
      store.recordAction({ at: now.toISOString(), actor: who.name, repo: null, taskId: null, runId: null, action: before === null ? "sign-in with a provider turned on" : "sign-in with a provider changed", outcome: "changed", source: "policy", detail: ssoChangeWords(before, saved.settings) });
      return found.ok ? back("said", `Saved. People can sign in with ${saved.settings.label}.`) : back("problem", `Saved, but ${saved.settings.label} didn't answer: ${found.said}`);
    }
    // Settings → Updates: start the `toolroll update` job. A step-up; the job writes the ledger entries.
    if (url.pathname === "/settings/updates" || url.pathname === "/settings/updates/seen" || url.pathname === "/settings/updates/cancel") {
      const body = readForm(posted, CONSOLE_FORMS.updates);
      const databaseFile = store.databaseFile();
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || databaseFile === null) return refuse(response, who, 403, "An instance operator updates Toolroll.", "/settings");
      const stateDir = dirname(databaseFile);
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/updates?${key}=${encodeURIComponent(words)}`);
      if (url.pathname === "/settings/updates/seen") { markWhatsNewSeen(stateDir); return redirect(response, "/settings/updates"); }
      if (url.pathname === "/settings/updates/cancel") return back("said", requestRuntimeUpdateCancel(stateDir));
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "Enter your Toolroll password to update.");
      const version = body.get("version") ?? "";
      const when: When | null = ({ now: "now", "when-idle": "when-idle", tonight: "at" } as Record<string, When>)[body.get("when") ?? ""] ?? null;
      if (!/^\d+\.\d+\.\d+$/.test(version) || when === null) return back("problem", "Choose when to update.");
      const current = options.updates?.current ?? PACKAGE_VERSION;
      if (!newerThan(version, current)) return back("problem", `Toolroll ${version} is not newer than ${current}. To go back, run toolroll update --rollback.`);
      const method = options.updates?.method ?? installMethod();
      if (method.kind === "npx" || method.kind === "source" || method.kind === "desktop") return back("problem", method.kind === "npx" ? "npx runs the latest release each time; there is nothing to update." : method.kind === "desktop" ? "Update it from the Toolroll app." : "This runs from a source checkout. Update it with git.");
      const before = runtimeUpdateStatus(stateDir).journal;
      if (before !== null && !runtimeUpdateTerminal(before.phase)) return back("problem", "An update is already under way.");
      if (when === "now") {
        const running = runningWorkWords(store.raw() as unknown as Parameters<typeof runningWorkWords>[0]);
        if (running !== null) return back("problem", `Work is running: ${running}. Choose When idle to update once it finishes.`);
      }
      const prepared = prepareRuntimeUpdate({ stateDir, databaseFile, current: { version: current, dist: options.updates?.dist ?? currentRuntime(current).dist }, actor: who.name, version, when, at: "03:00" }, clock());
      if ("refused" in prepared) return back("problem", prepared.refused);
      try { await (options.updates?.launch ?? launchRuntimeUpdate)({ databaseFile, id: prepared.id }); }
      catch (error) {
        abandonRuntimeUpdate(stateDir, prepared.id, `The update could not start: ${(error as Error).message}`, clock());
        return back("problem", `The update could not start: ${(error as Error).message}`);
      }
      // The job records its first step within moments; show it rather than the old page.
      return back("said", when === "at" ? `Update to ${version} scheduled for 03:00.` : `Updating to ${version}.`);
    }
    // v105: change how long each kind of data is kept. A step-up; the ledger keeps before → after for each kind.
    if (url.pathname === "/settings/retention") {
      const body = readForm(posted, CONSOLE_FORMS.retention);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator sets retention.", "/settings");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/retention?${key}=${encodeURIComponent(words)}`);
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "Enter your Toolroll password to change retention.");
      const before = store.retentionPeriods();
      // Only what the page offers (or the period already set): a hand-made value doesn't save.
      const offered = (kind: RetentionKind, days: number | null | undefined) => days !== undefined && periodChoices(kind, before[kind]).includes(days) ? days : undefined;
      const chosen = RETENTION_KINDS.map(({ kind }) => ({ kind, days: body.has(kind) ? offered(kind, parsePeriod(body.get(kind) ?? "")) : before[kind] }));
      if (chosen.some(one => one.days === undefined)) return back("problem", "Choose a period for each kind of data.");
      const changed = chosen.filter(one => one.days !== before[one.kind]);
      for (const one of changed) store.setRetentionPeriod(one.kind, one.days ?? null, who.name, now);
      return back("said", changed.length === 0 ? "Nothing changed." : "Saved. The next daily sweep uses these periods.");
    }
    // Settings → Storage: when a finished task's clean checkout goes, cleaning up what the preview showed, and throwing
    // away a checkout kept for its changes. Each takes the password; the ledger keeps every change and removal.
    if (url.pathname === "/settings/storage" || url.pathname === "/settings/storage/clean" || url.pathname === "/settings/storage/discard") {
      const body = readForm(posted, CONSOLE_FORMS.storage);
      const databaseFile = store.databaseFile();
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || databaseFile === null) return refuse(response, who, 403, "An instance operator looks after storage.", "/settings");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/storage?${key}=${encodeURIComponent(words)}`);
      const what = url.pathname.endsWith("/clean") ? "clean up" : url.pathname.endsWith("/discard") ? "discard a checkout" : "change checkout cleanup";
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", `Enter your Toolroll password to ${what}.`);
      if (url.pathname === "/settings/storage") {
        const cleanup = parseCleanup(body.get("cleanup") ?? "");
        if (cleanup === undefined) return back("problem", "Choose when a finished task's checkout is removed.");
        const before = store.checkoutCleanup();
        store.setCheckoutCleanup(cleanup, who.name, now);
        return back("said", cleanup === before ? "Nothing changed." : "Saved.");
      }
      const pool = storagePool(databaseFile);
      if (url.pathname.endsWith("/clean")) {
        // Only what the preview showed goes: when that changed since, the person looks again.
        const plan = await checkoutPlan(store, pool, clock(), { manual: true });
        if (plan.go.length === 0) return back("said", "Nothing to clean up.");
        if (body.get("preview") !== previewDigest(plan)) return back("problem", "What a clean-up would remove changed since you looked. Check the list again.");
        const done = await cleanCheckouts(store, pool, clock, { manual: true, actor: who.name, only: new Set(plan.go.map(one => one.path)) });
        saveSweep(store, { at: clock().toISOString(), source: "manual", actor: who.name, parts: [{ kind: "checkouts", count: done.removed.length, bytes: done.freed, failed: done.kept.filter(one => one.why === "git refused").length, items: done.removed.slice(0, 20).map(one => one.path) }] });
        return back("said", done.removed.length === 0 ? "Nothing was removed: those checkouts are no longer ready to go." : `Removed ${done.removed.length} checkout${done.removed.length === 1 ? "" : "s"}, about ${bytesWords(done.freed)}. Their branches stay.`);
      }
      const done = await discardCheckout(store, pool, body.get("path") ?? "", now, who.name);
      return done.ok ? back("said", `Discarded, about ${bytesWords(done.bytes)}. Its branch stays.`) : back("problem", done.message);
    }
    // Pull requests for one project: turn on (the checks run again and must match what the page showed), merge
    // settings, or turn off. Each takes the password and lands in the ledger.
    if (url.pathname === "/settings/pull-requests") {
      const body = readForm(posted, CONSOLE_FORMS.pullRequests);
      const repo = body.get("repo") ?? "";
      const known = [...new Set([...managedRepos(), ...store.knownRepos(), ...store.listProjects().map(one => one.path)])];
      if (who.via !== "cookie") return refuse(response, who, 403, REMOTE_MESSAGES["step-up"]);
      if (!known.includes(repo) || !visible(repo)) return refuse(response, who, 404, "No such project.", "/projects");
      if (who.role !== "approver" || store.isDemo()) return refuse(response, who, 403, "An approver sets up pull requests.", "/projects");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/pull-requests?repo=${encodeURIComponent(repo)}&${key}=${encodeURIComponent(words)}`);
      const act = body.get("act");
      if (!authenticateApprover(who, body.get("password") ?? "", repo).ok) return back("problem", "Enter your Toolroll password to change pull requests.");
      if (act === "on") {
        const checked = await checkPublishing(repo, options.publishExec === undefined ? {} : { exec: options.publishExec });
        if (!checked.ok) return back("problem", checked.message);
        if (checked.plan.githubRepo !== body.get("github") || checked.plan.base !== body.get("base")) return back("problem", "GitHub answered differently from what you saw. Check the details again.");
        savePublishing(store, checked.plan, who.name, {}, now);
        return back("said", "Pull requests are on.");
      }
      if (act === "settings") {
        const method = body.get("method") ?? "";
        if (!(MERGE_METHODS as readonly string[]).includes(method)) return back("problem", "Choose a merge method.");
        const saved = saveMergeSettings(store, repo, { mergeMethod: method as MergeMethod, mergeWhenGreen: body.get("when-green") === "1" }, who.name, now);
        return saved.ok ? back("said", "Saved.") : back("problem", saved.message);
      }
      if (act === "off") {
        const revoked = store.revokePublicationGrant(repo, who.name, now);
        if (revoked) store.recordAction({ at: now.toISOString(), actor: who.name, repo, taskId: null, runId: null, action: "pull requests turned off", outcome: "off", source: "policy" });
        return back("said", revoked ? "Pull requests are off." : "Pull requests were already off.");
      }
      return back("problem", "That change isn't available.");
    }
    // Checks for one project: the level, or the quick command (approved like `verify set --quick`). Each takes
    // the password and lands in the ledger.
    if (url.pathname === "/settings/checks") {
      const body = readForm(posted, CONSOLE_FORMS.checks);
      const repo = body.get("repo") ?? "";
      const known = [...new Set([...managedRepos(), ...store.knownRepos(), ...store.listProjects().map(one => one.path)])];
      if (who.via !== "cookie") return refuse(response, who, 403, REMOTE_MESSAGES["step-up"]);
      if (!known.includes(repo) || !visible(repo)) return refuse(response, who, 404, "No such project.", "/projects");
      if (who.role !== "approver" || store.isDemo()) return refuse(response, who, 403, "An approver sets a project's checks.", "/projects");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/checks?repo=${encodeURIComponent(repo)}&${key}=${encodeURIComponent(words)}`);
      if (!authenticateApprover(who, body.get("password") ?? "", repo).ok) return back("problem", "Enter your Toolroll password to change checks.");
      const act = body.get("act");
      // The automatic review switch: the policy log keeps before → after.
      if (act === "review") {
        const on = body.get("on") === "1";
        store.setReviewSwitch(repo, on, who.name, now);
        return back("said", on ? "Automatic review is on." : "Automatic review is off.");
      }
      // Batch checks: off by default; the ledger keeps before → after.
      if (act === "batch") {
        const on = body.get("on") === "1";
        const changed = setProjectBatchChecks(store, repo, on, who.name, now);
        return back("said", !changed.changed ? "Saved." : on ? "Batch checks are on." : "Batch checks are off.");
      }
      if (act === "level") {
        const level = body.get("level");
        if (!isCheckLevel(level)) return back("problem", "Choose Quick, Full or Off.");
        const changed = setProjectCheckLevel(store, repo, level, who.name, now);
        return back("said", changed.changed ? `Checks are ${CHECK_LEVEL_WORDS[level]}.` : "Saved.");
      }
      if (act === "quick") {
        const command = (body.get("command") ?? "").trim();
        const seconds = Number(body.get("timeout") ?? "180");
        if (command === "" || command.length > 2000 || hasDisguisedText(command)) return back("problem", "Enter the quick command: one line of up to 2000 characters.");
        if (/([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api_key|authorization|bearer|credential)[A-Za-z0-9_-]*\s*[=:]\s*)(?![$"']?\$)\S+/i.test(command) || /\/\/[^\s/@]+:[^\s/@]+@/.test(command)) {
          return back("problem", "That command seems to hold a credential. Use an environment variable instead.");
        }
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return back("problem", "Choose a time limit from 1 to 3600 seconds.");
        store.setVerifyCommand({ repo: quickVerifyKey(repo), command, timeoutMs: seconds * 1000, approvedBy: who.name }, now);
        store.recordAction({ at: now.toISOString(), actor: who.name, repo, taskId: null, runId: null, action: "quick check approved", outcome: "approved", source: "policy", detail: command.slice(0, 200) });
        return back("said", "Quick check approved.");
      }
      if (act === "quick-clear") {
        const cleared = store.clearVerifyCommand(quickVerifyKey(repo), who.name, now);
        if (cleared) store.recordAction({ at: now.toISOString(), actor: who.name, repo, taskId: null, runId: null, action: "quick check removed", outcome: "removed", source: "policy" });
        return back("said", cleared ? "Quick check removed. Quick builds run the full check." : "There was no quick check.");
      }
      return back("problem", "That change isn't available.");
    }
    // Sprint 8: back up now. An instance operator; the outcome is kept like a scheduled one's.
    if (url.pathname === "/settings/backups/now") {
      const databaseFile = store.databaseFile();
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || databaseFile === null) return refuse(response, who, 403, "An instance operator looks after backups.", "/settings");
      const made = await backupNow(store, databaseFile, "manual", clock);
      if (made.ok && made.checkpoint !== null && "problem" in made.checkpoint) return redirect(response, `/settings/backups?problem=${encodeURIComponent(`Backed up. The activity log failed its tamper check, so it was not anchored: ${made.checkpoint.problem}`)}`);
      return redirect(response, made.ok ? `/settings/backups?said=${encodeURIComponent("Backed up.")}` : `/settings/backups?problem=${encodeURIComponent(`The backup failed: ${made.error}`)}`);
    }
    // Sprint 8: change the backup schedule. A step-up; the ledger keeps before → after.
    if (url.pathname === "/settings/backups") {
      const body = readForm(posted, CONSOLE_FORMS.backups);
      const databaseFile = store.databaseFile();
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || databaseFile === null) return refuse(response, who, 403, "An instance operator looks after backups.", "/settings");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/backups?${key}=${encodeURIComponent(words)}`);
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "Enter your Toolroll password to change backups.");
      const every = body.get("every") ?? "";
      const hours = Number(every);
      if (every !== "off" && !(BACKUP_EVERY_HOURS as readonly number[]).includes(hours)) return back("problem", "Choose how often to back up.");
      const keep = Number(body.get("keep") ?? "");
      if (!Number.isSafeInteger(keep) || keep < 1 || keep > MAX_KEEP) return back("problem", `Keep between 1 and ${MAX_KEEP} backups.`);
      const typed = (body.get("folder") ?? "").trim();
      const folder = typed === "" || typed === defaultBackupFolder(databaseFile) ? null : typed;
      if (folder !== null) {
        const problem = checkBackupFolder(folder, [...new Set([...managedRepos(), ...store.knownRepos(), ...(options.poolRoot === undefined ? [] : [options.poolRoot])])]);
        if (problem !== null) return back("problem", problem);
      }
      const before = store.backupSettings();
      store.setBackupSettings({ enabled: every !== "off", everyHours: every === "off" ? before.everyHours : hours, keep, folder }, who.name, now);
      return back("said", every === "off" ? "Saved. Scheduled backups are off." : "Saved.");
    }
    // v105: download everything as a .zip. An instance operator, with a step-up; the ledger records it.
    if (url.pathname === "/settings/data") {
      const body = readForm(posted, CONSOLE_FORMS.data);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name)) return refuse(response, who, 403, "An instance operator exports data.", "/settings");
      if (!authenticateApprover(who, body.get("password") ?? "").ok) {
        return redirect(response, `/settings/data?problem=${encodeURIComponent("Enter your Toolroll password to download the export.")}`);
      }
      store.recordAction({ at: now.toISOString(), actor: who.name, repo: null, taskId: null, runId: null, action: "everything exported", outcome: "exported", source: "access", detail: "downloaded as a .zip" });
      const exported = buildExport(store, { who: who.name, now, evidenceRoot, configDir: options.configDir ?? null });
      const zip = exportZip(exported);
      response.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${exported.root}.zip"`, "content-length": String(zip.length),
        "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return void response.end(zip);
    }
    // Settings → Flows → Switch on: a starter flow's zones and trigger, made together.
    if (url.pathname === "/settings/flows/on") {
      const body = readForm(posted, CONSOLE_FORMS.flowsOn);
      const repo = body.get("repo") ?? "";
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/flows?repo=${encodeURIComponent(repo)}&${key}=${encodeURIComponent(words)}`);
      const known = [...new Set([...(admissionList() ?? []), ...managedRepos(), ...store.knownRepos()])];
      if (who.via !== "cookie" || who.role !== "approver" || store.isDemo()) return refuse(response, who, 403, "An approver switches starter flows on.", "/settings/flows");
      if (!known.includes(repo) || !visible(repo)) return refuse(response, who, 404, "No such project.", "/settings/flows");
      const starter = starterOf(body.get("starter") ?? "");
      if (starter === null) return back("problem", "Choose a starter flow.");
      const switched = switchOnStarter(store, starter, repo, who.name, clock(), options.configDir ?? null);
      return switched.ok ? back("said", switched.said) : back("problem", switched.said);
    }
    // Settings → Integrations → Send test: one harmless read-only check of one integration, now.
    if (url.pathname === "/settings/integrations/test") {
      const body = readForm(posted, CONSOLE_FORMS.integrationsTest);
      if (who.via !== "cookie" || who.role !== "approver" || restricted() || !options.configDir) return refuse(response, who, 403, "An installation approver tests integrations.", "/settings");
      const key = body.get("key") ?? "";
      const back = (name: "said" | "problem", words: string) => redirect(response, `/settings/integrations?${name}=${encodeURIComponent(words)}`);
      const checked = (await integrations.check([key])).find(one => one.key === key);
      if (checked === undefined) return back("problem", "That integration isn't here any more.");
      return checked.state === "connected" ? back("said", `${checked.name} works${checked.account === null ? "" : ` (${checked.account})`}.`)
        : back("problem", `${checked.name}: ${checked.action.kind === "fix" ? checked.action.words : "not set up."}`);
    }
    // v104: change where monitoring goes. A step-up; the ledger keeps before → after (addresses, never secrets).
    if (url.pathname === "/settings/monitoring") {
      const body = readForm(posted, CONSOLE_FORMS.monitoring);
      if (who.via !== "cookie" || !store.isInstanceOperator(who.name) || !options.configDir) return refuse(response, who, 403, "An instance operator sets up monitoring.", "/settings");
      const back = (key: "said" | "problem", words: string) => redirect(response, `/settings/monitoring?${key}=${encodeURIComponent(words)}`);
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("problem", "Enter your Toolroll password to change monitoring.");
      const before = readMonitoring(options.configDir);
      // Never into Toolroll's own folder, a project or the build checkouts: an agent could read the stream there.
      const saved = saveMonitoring(options.configDir, { webhook: body.get("webhook") ?? "", folder: body.get("folder") ?? "", tracesEndpoint: body.get("traces") ?? "",
        headerName: body.get("header-name") ?? "", headerValue: body.get("header-value") ?? "", rotate: body.get("rotate") === "1" }, before,
        [...new Set([...managedRepos(), ...store.knownRepos(), ...(options.poolRoot === undefined ? [] : [options.poolRoot])])]);
      if (!saved.ok) return back("problem", saved.said);
      const after = saved.settings;
      // A destination that's new or points elsewhere starts over on the monitoring loop's next pass.
      const change = monitoringChange(before, after, saved.secret !== null);
      if (change !== null) {
        store.recordAction({ at: now.toISOString(), actor: who.name, repo: null, taskId: null, runId: null, action: "monitoring changed", outcome: "changed", source: "policy", detail: change });
      }
      if (saved.secret !== null && after.webhook !== null) {
        return sendScreen(response, 200, screen("Signing secret", signingSecretHtml(after.webhook.url, saved.secret), { chrome: chromeFor(projectOf(who, request) ?? null, "settings"), forceSensitive: true }));
      }
      return back("said", "Saved. Deliveries start within a few seconds.");
    }
    if (url.pathname === "/settings/tools/connect") {
      const body = readForm(posted, CONSOLE_FORMS.toolsConnect);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "Sign in as an approver to connect tools.", "/settings/tools");
      const repo = body.get("repo") ?? "";
      const reachable = (one: string) => visible(one) && consoleProjects().includes(one);
      if (!reachable(repo)) return refuse(response, who, 403, "That project is outside your access.", "/projects");
      // "Also connect to …": a service connected on the shown project, signed in again for another project.
      const also = body.get("also");
      const split = also === null ? -1 : also.indexOf(":");
      const service = oneClickOf(also === null ? body.get("service") ?? "" : split > 0 ? also.slice(0, split) : "");
      // An app on this computer (Figma's desktop app) connects here, never "also" elsewhere.
      const local = service === null && also === null ? localConnectOf(body.get("service") ?? "") : null;
      const chosen = service ?? local;
      const target = also === null ? repo : split > 0 ? also.slice(split + 1) : "";
      // From a gallery template that uses this tool: it comes back to that template's page, for this project.
      const gallery = also === null && chosen !== null ? galleryTemplateOf(body.get("template") ?? "") : null;
      const template = gallery !== null && (gallery.tools ?? []).includes(chosen!.id) ? gallery.id : null;
      const kit = template === null ? kitOf(body.get("kit") ?? "")?.id ?? null : null;
      // A Connect that fails comes back to its own button, where the reason is said (no #fragment: one stops the alert's
      // autofocus); an "Also connect to" refusal goes back to the Connect card.
      const back = (words: string, page = repo) => template !== null ? redirect(response, `/flows/new/${template}?repo=${encodeURIComponent(page)}&problem=${encodeURIComponent(words)}`)
        : redirect(response, `/settings/tools?repo=${encodeURIComponent(page)}${kit === null ? "" : `&kit=${kit}`}${chosen === null || also !== null ? "" : `&connect=${chosen.id}`}&problem=${encodeURIComponent(words)}${also === null ? "" : "#connect"}`);
      // The page posts the project it showed; a post from a page showing another project is stale.
      const shown = body.get("shown") ?? "";
      if (shown !== repo) return back("The project changed; connect again.", reachable(shown) ? shown : repo);
      if (chosen === null) return back("Choose a service to connect.");
      if (also !== null && service !== null) {
        if (!reachable(target)) return refuse(response, who, 403, "That project is outside your access.", "/projects");
        if (connectionsOf(store, repo).find(one => one.id === service.id)?.state !== "connected") return back(`${service.label} isn't connected to ${projectName(repo)}.`);
        if (connectionsOf(store, target).find(one => one.id === service.id)?.state !== "open") return back(`${projectName(target)} already has ${service.label}.`);
      }
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return back("Enter your Toolroll password to connect a tool.");
      // An app on this computer: added like a common tool and tested; one that can't be reached isn't kept.
      if (local !== null) {
        const had = projectToolsOf(store, repo).find(one => one.name === local.id);
        if (had !== undefined && localAppOf(had.spec) === null) return back(`This project already has a tool called ${local.id}, set up another way. Remove it on this page to connect ${local.label}.`);
        if (had === undefined) {
          const { label: _label, ...spec } = catalogTool(local.id)!;
          const added = addToolTo(store, repo, spec, `${local.label}, connected on this computer`, who.name, clock(), { home: toolHome });
          if (!added.ok) return back(added.message);
        }
        const tested = await testToolOf(store, repo, local.id, clock(), { home: toolHome, omitEnv: ALL_CREDENTIAL_ENV });
        const connected = `${local.label} is connected: ${tested?.tools.length ?? 0} action${tested?.tools.length === 1 ? "" : "s"}.`;
        if (tested?.ok) return redirect(response, template !== null ? `/flows/new/${template}?repo=${encodeURIComponent(repo)}&said=${encodeURIComponent(connected)}`
          : `/settings/tools?repo=${encodeURIComponent(repo)}${kit === null ? "" : `&kit=${kit}`}&said=${encodeURIComponent(connected)}#tool-${local.id}`);
        if (had === undefined) removeToolFrom(store, repo, local.id, who.name, clock(), toolHome);
        return back(tested?.problem ?? `${local.label} didn't answer.`);
      }
      if (service === null) return back("Choose a service to connect.");
      const origin = consoleOrigin(request.headers.host);
      if (origin === null) return back("Connect tools from this computer (localhost) or from your https address.");
      // Reconnect read-only (from a connected service's Tools entry): the same sign-in, asking only to read.
      const readOnly = also === null && body.get("access") === "read";
      const started = await startConnect({ service: service.id, repo: target, by: who.name, origin, kit: also === null ? kit : null, template, readOnly }, options.connectFetch ?? fetch);
      if (!started.ok) return back(started.said);
      for (const [key, visit] of connectVisits) if (visit.expires < Date.now()) connectVisits.delete(key);
      connectVisits.set(started.state, started.visit);
      return goOutside(response, started.go, `Going to ${service.label} to sign in…`, { state: started.state, path: CONNECT_CALLBACK, secure: origin.startsWith("https:") });
    }
    if (url.pathname === "/settings/tools/change") {
      const body = readForm(posted, CONSOLE_FORMS.toolsChange);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "Sign in as an approver to manage tools.", "/settings/tools");
      const repo = body.get("repo") ?? "";
      if (!visible(repo) || !consoleProjects().includes(repo)) return refuse(response, who, 403, "That project is outside your access.", "/projects");
      const back = (key: "said" | "problem", words: string, anchor = "") => redirect(response, `/settings/tools?repo=${encodeURIComponent(repo)}&${key}=${encodeURIComponent(words)}${anchor}`);
      // As for Connect: a post from a page that showed another project is refused, never applied here.
      const shown = body.get("shown") ?? "";
      if (shown !== repo) {
        const page = visible(shown) && consoleProjects().includes(shown) ? shown : repo;
        return redirect(response, `/settings/tools?repo=${encodeURIComponent(page)}&problem=${encodeURIComponent("The project changed; try again.")}`);
      }
      const action = body.get("action") ?? "";
      const name = body.get("name") ?? "";
      // Anything that adds what a build can run or reach, or a secret, needs the password.
      if (["add-catalog", "add-custom", "import", "secret"].includes(action) && !authenticateApprover(who, body.get("password") ?? "").ok) {
        return back("problem", "Enter your Toolroll password to change this project's tools.");
      }
      const now = clock();
      const finish = (added: { ok: true; spec: ToolSpec } | { ok: false; message: string }, label: string) => {
        if (!added.ok) return back("problem", added.message);
        const needs = added.spec.secrets.filter(one => !one.optional).map(one => one.name);
        return back("said", `Added ${label}. ${needs.length > 0 ? `Set ${needs.join(" and ")} below to finish.` : "Test it to check it starts."} Work you approve from now on can use it.`, `#tool-${added.spec.name}`);
      };
      try {
        if (action === "add-catalog") {
          const chosen = catalogTool(body.get("catalog") ?? "");
          if (chosen === null) return back("problem", "Choose a tool from the list.");
          const { label: _label, ...spec } = chosen;
          return finish(addToolTo(store, repo, spec, "the common tools list", who.name, now, { home: toolHome }), chosen.label);
        }
        if (action === "add-custom") {
          const transport = body.get("transport") === "http" ? "http" : "stdio";
          const target = body.get("target") ?? "";
          const secrets = (body.get("secrets") ?? "").split(",").map(one => one.trim()).filter(Boolean);
          const parts = transport === "stdio" ? splitCommandLine(target) : [];
          const spec = { name, transport, command: parts[0] ?? null, args: parts.slice(1), url: transport === "http" ? target : null,
            secrets: secrets.map(one => ({ name: one, optional: false })), bearer: transport === "http" ? secrets[0] ?? null : null, headerSecrets: {}, about: "" } as ToolSpec;
          return finish(addToolTo(store, repo, spec, "added by hand", who.name, now, { home: toolHome }), name);
        }
        if (action === "import") {
          const wanted = body.getAll("import");
          if (wanted.length === 0) return back("problem", "Choose at least one tool to add.");
          const found = discoverTools(repo, await codexServers(repo), toolHome);
          const added: string[] = [], problems: string[] = [];
          for (const one of wanted) {
            const match = found.find(tool => tool.spec.name === one);
            if (match === undefined) { problems.push(`${one} is no longer on this computer`); continue; }
            const result = addToolTo(store, repo, match.spec, match.source, who.name, now, { values: match.values, home: toolHome });
            if (result.ok) added.push(one); else problems.push(result.message);
          }
          return problems.length > 0 ? back("problem", `${added.length > 0 ? `Added ${added.join(", ")}. ` : ""}${problems.join(" ")}`) : back("said", `Added ${added.join(", ")}. Test each to check it starts. Work you approve from now on can use them.`);
        }
        const tool = projectToolsOf(store, repo).find(one => one.name === name);
        if (tool === undefined) return back("problem", "That tool is no longer on this project.");
        if (action === "remove") {
          removeToolFrom(store, repo, name, who.name, now, toolHome);
          return back("said", `Removed ${name}. No build uses it from now on.`);
        }
        if (action === "test") {
          const test = await testToolOf(store, repo, name, now, { omitEnv: ALL_CREDENTIAL_ENV, home: toolHome });
          return test === null || !test.ok ? back("problem", `${name}: ${test?.problem ?? "the test did not run."}`, `#tool-${name}`) : back("said", `${name} works: ${test.tools.length} tool${test.tools.length === 1 ? "" : "s"}.`, `#tool-${name}`);
        }
        if (action === "secret") {
          const secret = body.get("secret") ?? "";
          if (!tool.spec.secrets.some(one => one.name === secret)) return back("problem", "Choose one of this tool's secrets.");
          setToolSecret(repo, name, secret, body.get("value") ?? "", toolHome);
          return back("said", `Saved ${secret} for ${name}. It is never shown again.`, `#tool-${name}`);
        }
        return back("problem", "Choose a supported tools action.");
      } catch (error) {
        return back("problem", error instanceof Error ? error.message : "Tools could not be changed. Try again.");
      }
    }
    if (url.pathname === "/settings/appearance") {
      const body = readForm(posted, CONSOLE_FORMS.appearance);
      // A per-browser preference, not a shared setting: it lives in this
      // person's own cookie and never in the database.
      const accentField = body.get("accent");
      if (accentField !== null) {
        const accent = normalHex(accentField);
        if (accent === null) return refuse(response, who, 400, "Choose a colour as six hex digits, like #6e56cf.", "/settings");
        response.setHeader("Set-Cookie", accent === DEFAULT_ACCENT
          ? "so-accent=; SameSite=Lax; Path=/; Max-Age=0"
          : `so-accent=${accent.slice(1)}; SameSite=Lax; Path=/; Max-Age=31536000`);
        // The picker saves in the background as the colour settles; a plain form post goes back.
        if (body.get("quiet") === "1") { response.writeHead(204); response.end(); return; }
        return redirect(response, safeReturn(body.get("return") ?? "/settings"));
      }
      const theme = body.get("theme") ?? "";
      if (!["system", "light", "dark"].includes(theme)) return refuse(response, who, 400, "Choose System, Light or Dark.", "/settings");
      const back = safeReturn(body.get("return") ?? "/settings");
      response.setHeader("Set-Cookie", theme === "system"
        ? "so-theme=; SameSite=Lax; Path=/; Max-Age=0"
        : `so-theme=${theme}; SameSite=Lax; Path=/; Max-Age=31536000`);
      return redirect(response, back);
    }
    if (url.pathname.startsWith("/settings/models/")) {
      const body = readForm(posted, CONSOLE_FORMS.models);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "Sign in as an approver to change models.", "/settings/models");
      const back = (said: string, bad = false) => redirect(response, `/settings/models?${bad ? "problem" : "said"}=${encodeURIComponent(said)}`);
      if (url.pathname === "/settings/models/check") {
        const checked = await checkModels(store, now, modelSeams);
        return back(checked.ok ? `Checked. ${checked.added.filter(one => one.source !== "openrouter").length || "No"} new model${checked.added.filter(one => one.source !== "openrouter").length === 1 ? "" : "s"}.` : checked.problem ?? "The check did not finish.", !checked.ok);
      }
      if (url.pathname === "/settings/models/watch") {
        const enabled = body.get("enabled") === "1";
        setWatch(store, enabled, who.name, now);
        return back(enabled ? "Automatic checks are on." : "Automatic checks are off.");
      }
      if (url.pathname === "/settings/models/update") {
        const tool = body.get("tool") ?? "";
        if (!(tool in RUNTIME_TOOLS)) return back("Choose Claude Code, Codex or Gemini CLI.", true);
        const updated = await updateRuntime(store, tool as RuntimeTool, who.name, now, modelSeams);
        return back(updated.message, !updated.ok);
      }
      if (url.pathname === "/settings/models/agent") {
        const phase = body.get("phase") ?? "", agent = body.get("agent") ?? "";
        if (!["plan", "build", "review", "repair"].includes(phase)) return back("Choose a role.", true);
        const role = ROLE_TITLES[phase as RoleView["phase"]];
        if (agent === "inherit") {
          if (phase !== "repair") return back("Choose a model.", true);
          store.clearPhaseConfig(INSTALLATION_SCOPE, "repair");
          return back("Repairs now use the builder's agent.");
        }
        const split = agent.indexOf("|");
        const provider = split < 0 ? "" : agent.slice(0, split), model = split < 0 ? "" : agent.slice(split + 1);
        if (!isProviderId(provider) || !validModelId(model)) return back("Choose a model from the list.", true);
        const valid = validateSpec({ provider, model });
        if (!valid.ok) return back(valid.problem, true);
        if (phase === "review" && provider === "gemini") return back("Gemini cannot review yet. Choose Claude or Codex.", true);
        const build = store.phaseConfig(INSTALLATION_SCOPE, "build");
        if (phase === "repair" && build !== null && build.provider !== provider) return back(`Repairs must use the builder's provider (${build.provider}).`, true);
        store.setPhaseConfig(INSTALLATION_SCOPE, phase, provider, model, who.name, now);
        const repair = store.phaseConfig(INSTALLATION_SCOPE, "repair");
        let extra = "";
        if (phase === "build" && repair !== null && repair.provider !== provider) {
          store.clearPhaseConfig(INSTALLATION_SCOPE, "repair");
          extra = " Repairs now follow the builder.";
        }
        return back(`${role} now uses ${modelWords(store, provider, model)} for new tasks.${extra}`);
      }
      return refuse(response, who, 404, "No such models action.", "/settings/models");
    }
    if (url.pathname === "/settings/knowledge/refresh") {
      const body = readForm(posted, CONSOLE_FORMS.knowledgeRefresh);
      if (who.via !== 'cookie' || who.role !== 'approver') return refuse(response, who, 403, 'Sign in as an approver to refresh project context.', '/settings/knowledge');
      const repo = body.get('repo') ?? '';
      if (!visible(repo) || !store.accountCanAccess(who.name, repo) || !consoleProjects().includes(repo)) return refuse(response, who, 403, 'That project is outside your access.', '/settings/knowledge');
      const refreshed = await repositoryContext({ repo, query: '', refresh: true, cacheRoot: join(dirname(evidenceRoot), 'repository-context') });
      return sendScreen(response, refreshed.index.status === 'ready' ? 200 : 503, screen('Project context', `<h1>Project context</h1><p>${refreshed.index.status === 'ready' ? 'Code index refreshed.' : 'The index is unavailable. Source search still works.'}</p><a class="button-link" href="/settings/knowledge?repo=${encodeURIComponent(repo)}">Open knowledge</a>`, { chrome: chromeFor(repo, 'settings') }));
    }
    if (url.pathname === "/settings/knowledge/proposal") {
      const body = readForm(posted, CONSOLE_FORMS.knowledgeProposal);
      if (who.via !== 'cookie' || who.role !== 'approver') return refuse(response, who, 403, 'Sign in as an approver to decide memory proposals.', '/settings/knowledge');
      const repo = body.get('repo') ?? '', decision = body.get('decision') ?? '';
      if (!visible(repo) || !consoleProjects().includes(repo)) return refuse(response, who, 403, 'That project is outside your access.', '/settings/knowledge');
      if (!['accept', 'reject'].includes(decision) || !/^[0-9]{1,12}$/.test(body.get('proposal') ?? '')) return refuse(response, who, 400, 'Choose accept or reject for one proposal.', '/settings/knowledge');
      try { decideProposal(store, { repo, actor: who.name, id: Number(body.get('proposal')), decision: decision as 'accept' | 'reject' }, now); }
      catch (error) { return sendScreen(response, 409, screen('Knowledge', `<h1>Knowledge</h1><p role="alert">${escape(error instanceof Error ? error.message : 'That proposal could not be decided.')}</p><p><a href="/settings/knowledge?repo=${encodeURIComponent(repo)}">Back to knowledge</a></p>`, { chrome: chromeFor(repo, 'settings') })); }
      return redirect(response, `/settings/knowledge?repo=${encodeURIComponent(repo)}&saved=1`);
    }
    if (url.pathname === "/settings/knowledge/decision") {
      const body = readForm(posted, CONSOLE_FORMS.knowledgeDecision);
      if (who.via !== 'cookie' || who.role !== 'approver') return refuse(response, who, 403, 'Sign in as an approver to change project decisions.', '/settings/knowledge');
      const repo = body.get('repo') ?? '', action = body.get('action') ?? '';
      if (!visible(repo) || !consoleProjects().includes(repo)) return refuse(response, who, 403, 'That project is outside your access.', '/settings/knowledge');
      if ((['repo', 'action', 'claim', 'why', 'decision', 'reason'] as const).some(k => body.getAll(k).length > 1) || !['record', 'retire'].includes(action)) return refuse(response, who, 400, 'Choose record or retire.', '/settings/knowledge');
      try {
        if (action === 'record') recordDecision(store, { repo, actor: who.name, draft: { claim: body.get('claim') ?? '', why: body.get('why') ?? '', sourceKind: 'manual' } }, now);
        else retireDecision(store, { repo, actor: who.name, id: Number(body.get('decision')), reason: body.get('reason') ?? '' }, now);
      } catch (error) {
        const draft = { claim: body.get('claim') ?? '', why: body.get('why') ?? '' };
        let content = '';
        try { content = decisionsHtml(repo, listDecisions(store, repo, who.name, { limit: 50 }), who.session.csrf, true, draft, error instanceof Error ? error.message : 'Save failed. Your draft is below.'); } catch { content = `<p role="alert">Project decisions are unavailable. Your unsaved draft is below.</p><pre class="knowledge">${escape(JSON.stringify(draft, null, 2))}</pre>`; }
        return sendScreen(response, 409, screen('Knowledge', `<h1>Knowledge</h1>${content}`, { chrome: chromeFor(repo, 'settings') }));
      }
      return redirect(response, `/settings/knowledge?repo=${encodeURIComponent(repo)}&saved=1`);
    }
    if (url.pathname === "/settings/knowledge/change") {
      const body = readForm(posted, CONSOLE_FORMS.knowledgeChange);
      if (who.via !== 'cookie' || who.role !== 'approver') return refuse(response,who,403,'Sign in as an approver to change project knowledge.','/settings/knowledge');
      const repo = body.get('repo') ?? '', action = body.get('action') ?? '';
      if (!visible(repo) || ![...(admissionList() ?? []),...managedRepos(),...store.knownRepos()].includes(repo)) return refuse(response,who,403,'That project is outside your access.','/settings/knowledge');
      if ((['repo','action','identity','revision','instructions','title','content','path','id','restore'] as const).some(k=>body.getAll(k).length>1) || !['instructions','save','remove','restore','apply'].includes(action) || !/^[0-9]+$/.test(body.get('revision')??'')) return refuse(response,who,400,'Invalid knowledge form.','/settings/knowledge');
      const draft:KnowledgeDraft = Object.fromEntries((['instructions','title','content','path','id'] as const).filter(k=>body.has(k)).map(k=>[k,body.get(k)!]));
      try {
        if (action === 'apply') applySavedKnowledge(store,repo,who.name,clock());
        else changeKnowledge(store,{repo,actor:who.name,identity:body.get('identity')??'',revision:Number(body.get('revision')),action:action as 'instructions'|'save'|'remove'|'restore',draft,restore:Number(body.get('restore'))},clock());
      } catch (error) {
        let content = `<p role="alert">Project knowledge is unavailable. Your unsaved draft is below.</p><pre class="knowledge">${escape(JSON.stringify(draft,null,2))}</pre>`;
        try { content=knowledgeHtml(knowledgeView(store,repo,who.name),who.session.csrf,true,draft,error instanceof Error?error.message:'Save failed. Your draft is below.'); } catch { /* never render unverified saved context */ }
        return sendScreen(response,409,screen('Knowledge',`<h1>Knowledge</h1>${content}`,{chrome:chromeFor(repo,'settings')}));
      }
      return redirect(response,`/settings/knowledge?repo=${encodeURIComponent(repo)}&saved=1`);
    }
    if (url.pathname === "/settings/learning/change") {
      const body = readForm(posted, CONSOLE_FORMS.learningChange);
      if (who.via !== "cookie") return refuse(response, who, 403, "Sign in to change learning.", "/settings/learning");
      const repo = body.get("repo") ?? "", action = body.get("action") ?? "";
      if (!visible(repo) || !consoleProjects().includes(repo)) return refuse(response, who, 403, "That project is outside your access.", "/settings/learning");
      if ((["repo", "action", "identity", "revision", "lesson", "version", "sha"] as const).some(k => body.getAll(k).length > 1) || !["adopt", "disable", "reset", "enable", "pause"].includes(action) || !/^[0-9]+$/.test(body.get("revision") ?? "")) return refuse(response, who, 400, "Invalid learning form.", "/settings/learning");
      try {
        changeLearning(store, evidenceRoot, { repo, actor: who.name, identity: body.get("identity") ?? "", revision: Number(body.get("revision")), action: action as "adopt" | "disable" | "reset" | "enable" | "pause", lesson: Number(body.get("lesson")), version: Number(body.get("version")), sha: body.get("sha") ?? "" }, clock());
      } catch (error) {
        return sendScreen(response, 409, screen("Learning", `<section class="learning"><h1>Learning</h1><p class="problem" role="alert">${escape(error instanceof Error ? error.message : "Learning could not be changed. Reload to retry.")}</p><a class="button-link" href="/settings/learning?repo=${encodeURIComponent(repo)}">Reload Learning</a></section>`));
      }
      return redirect(response, `/settings/learning?repo=${encodeURIComponent(repo)}`);
    }

    if (["/control/setup-preview", "/control/setup-approve", "/control/instructions-preview", "/control/instructions-approve"].includes(url.pathname)) {
      const body = readForm(posted, CONSOLE_FORMS.projectSetup);
      if (who.via !== "cookie") return refuse(response, who, 403, REMOTE_MESSAGES["step-up"]);
      const project = projectOf(who, request);
      if (project == null || body.get("repo") !== project || !visible(project)) return refuse(response, who, 409, "The selected project changed. Open project setup again.", "/control");
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      if (url.pathname.includes("instructions")) {
        const preview = previewProjectInstructions(project);
        if (!preview.ok) return refuse(response, who, 400, preview.message, "/control");
        const nonceKey = `project-instructions:${project}`;
        if (url.pathname.endsWith("preview")) {
          const nonce = mintApprovalNonce(who.name, nonceKey, preview.fingerprint);
          return sendScreen(response, 200, screen("Review agent instructions", `<h1>Review agent instructions</h1><p>${escape(preview.plan.skillPath)}</p><pre class="recap">${escape(preview.content)}</pre><form method="post" action="/control/instructions-approve">${hiddenFields({ csrf, repo: project, nonce, fingerprint: preview.fingerprint })}<label>Your password<input type="password" name="token" autocomplete="current-password" required></label><button>Add these instructions</button></form>`, { chrome: chromeFor(project, "settings") }));
        }
        if (who.via === "cookie" && !consumeApprovalNonce(body.get("nonce") ?? "", who.name, nonceKey, body.get("fingerprint") ?? "")) return refuse(response, who, 409, "This instruction preview expired. Review it again.", "/control");
        if (!authenticateApprover(who, body.get("token") ?? "").ok) return refuse(response, who, 403, "Your operator credential is required.", "/control");
        const added = addProjectInstructions(project, body.get("fingerprint") ?? "");
        if (!added.ok) return refuse(response, who, 409, "The project instructions could not be installed. Review setup again.", "/control");
        return redirect(response, "/control");
      }
      const inputs: SetupInputs = { provider: body.get("provider") ?? "", model: body.get("model") ?? "", command: body.get("command") ?? "", seconds: body.get("seconds") ?? "" };
      const preview = previewSetup(store, project, inputs);
      if (!preview.ok) return refuse(response, who, 400, preview.message, "/control");
      const nonceKey = `project-setup:${project}`;
      if (url.pathname.endsWith("preview")) {
        const nonce = mintApprovalNonce(who.name, nonceKey, preview.fingerprint);
        return sendScreen(response, 200, screen("Approve project setup", setupPreviewHtml(inputs, { csrf, repo: project, fingerprint: preview.fingerprint, nonce }), { chrome: chromeFor(project, "settings") }));
      }
      if (who.via === "cookie" && !consumeApprovalNonce(body.get("nonce") ?? "", who.name, nonceKey, body.get("fingerprint") ?? "")) return refuse(response, who, 409, "This setup preview expired. Review it again.", "/control");
      const approved = approveSetup(store, project, inputs, body.get("fingerprint") ?? "", who.name, body.get("token") ?? "", now);
      if (!approved.ok) return refuse(response, who, 409, approved.message, "/control");
      return redirect(response, "/control");
    }

    if (["connect","pair","unpair","disconnect","alerts"].some(action=>url.pathname===`/settings/slack/${action}`)) {
      const body = readForm(posted, CONSOLE_FORMS.slack);
      if (who.via !== "cookie" || who.role !== "approver" || restricted() || !options.configDir) return refuse(response,who,403,"An installation approver can connect Slack.","/settings");
      const dir=options.configDir, state=new ChatState(store,"slack"), action=url.pathname.split("/").at(-1);
      const show=(problem:string,status=400)=>sendScreen(response,status,screen("Slack",slackSettingsHtml(store,dir,who.session.csrf,{problem,who:who.name}),{chrome:chromeFor(projectOf(who,request)??null,"settings")}));
      if ((["password","app-token","bot-token"] as const).some(key=>body.getAll(key).length>1)) return show("Submit one value for each field.");
      const credentials=loadSlackCredentials(dir);
      if(action==="alerts") {
        if(!credentials || !state.bindings(credentials.installation).some(one=>state.live(one))) return show("Pair your Slack account first.",409);
        savePrimary(dir,"slack");return redirect(response,"/settings/slack");
      }
      if(!authenticateApprover(who, body.get("password")??"").ok) return show("Enter your Toolroll password to change Slack access.",403);
      const generation=store.accountOf(who.name)!.generation;
      if(action==="connect") {
        try {
          const checked=await checkSlackCredentials((body.get("app-token")??"").trim(),(body.get("bot-token")??"").trim(),options.slackFetcher);
          const account=store.accountOf(who.name);
          if(account?.role!=="approver"||account.generation!==generation||account.revokedAt!==null) return show("Your access changed. Sign in again.",403);
          if(credentials || loadSlackCredentials(dir)) return show("Disconnect the current Slack app before connecting another.",409);
          saveSlackCredentials(dir,checked);
        } catch(error) {return show(error instanceof SlackError?error.message:"Slack could not be connected. Check the tokens and try again.");}
      } else if(action==="disconnect") {
        if(credentials) state.revoke(credentials.installation,now);
        clearSlackCredentials(dir);
      } else if(action==="unpair") {
        const mine=credentials?state.bindings(credentials.installation).find(one=>one.approver===who.name):undefined;
        if(mine) state.revokeBinding(mine,now);
      } else if(action==="pair") {
        if(!credentials) return show("Connect your Slack app first.",409);
        const mine=state.bindings(credentials.installation).find(one=>one.approver===who.name);
        if(mine&&state.live(mine)) return show("Your Slack account is already paired. Unpair it before pairing another.",409);
        if(mine) state.revokeBinding(mine,now);
        const code=state.pairing(credentials.installation,who.name,generation,now);
        return sendScreen(response,200,screen("Pair Slack",slackSettingsHtml(store,dir,who.session.csrf,{code,who:who.name}),{chrome:chromeFor(projectOf(who,request)??null,"settings"),forceSensitive:true}));
      }
      return redirect(response,"/settings/slack");
    }

    if (url.pathname === "/settings/telegram/retry") {
      // The signed-in person's own unsent replies only: already written and fenced on the pairing; this sends them again now.
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver can retry their own replies.", "/settings");
      store.retryTelegramReplies(who.name, now);
      return redirect(response, "/settings/telegram");
    }
    // Approving from chat, as the person's lasting setting (chat-approval.ts): for all their projects or one. Turning it
    // on or changing its limits is the mode's ceremony (the exact terms, a single-use nonce bound to them, the password
    // typed again); turning it off is one step, csrf only. Every change is a ledger line.
    if (url.pathname === "/settings/chat-approval/confirm" || url.pathname === "/settings/chat-approval/save" || url.pathname === "/settings/chat-approval/off") {
      const body = readForm(posted, CONSOLE_FORMS.chatApproval);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver turns on approving from their own chat.", "/settings");
      if ((["scope", "full-access", "cap-usd", "nonce", "digest", "token"] as const).some(key => body.getAll(key).length > 1)) return refuse(response, who, 400, "Submit one value for each field.", "/settings");
      const given = (body.get("scope") ?? "all").trim();
      const scope = given === "all" || given === "" ? CHAT_APPROVAL_ALL : canonicalProject(given) ?? given;
      if (scope !== CHAT_APPROVAL_ALL && !(visible(scope) && store.accountCanAccess(who.name, scope))) return refuse(response, who, 403, "That isn't one of your projects.", "/settings");
      const where = scope === CHAT_APPROVAL_ALL ? "all your projects" : projectName(scope);
      if (url.pathname.endsWith("/off")) {
        const saved = setChatApproval(store, { approver: who.name, scope, enabled: false, via: "the console" }, now);
        return saved.ok ? redirect(response, `/settings?said=${encodeURIComponent(saved.said)}`) : refuse(response, who, 400, saved.message, "/settings");
      }
      const usd = (body.get("cap-usd") ?? "").trim();
      const cap = usd === "" ? null : Number(usd);
      if (cap !== null && !(Number.isFinite(cap) && cap >= 0 && cap <= 10_000)) return refuse(response, who, 400, "Give the attempt limit in dollars, like 5.", "/settings");
      const limits = { fullAccess: body.get("full-access") === "1", capMicrousd: cap === null ? null : Math.round(cap * 1_000_000) };
      const digest = createHash("sha256").update(JSON.stringify({ scope, ...limits })).digest("hex");
      if (url.pathname.endsWith("/confirm")) {
        const nonce = mintApprovalNonce(who.name, "chat-approval", digest);
        const html = `<h1 style="overflow-wrap:anywhere">Approve from chat in ${escape(where)}</h1>` +
          `<form method="post" action="/settings/chat-approval/save" class="card approve-form">` +
          hiddenFields({ csrf: who.session.csrf, nonce, digest, scope: scope === CHAT_APPROVAL_ALL ? "all" : scope, "full-access": limits.fullAccess ? "1" : "", "cap-usd": usd }) +
          `<p>Your own taps in your paired chat approve plans and merges until you turn this off. It doesn't expire.</p>` +
          `<p class="recap">Limits: ${escape(chatApprovalWords(limits))}.</p>` +
          `<p class="recap">Plans written for you, protected paths, two-person rules and your organisation's policy still open in Toolroll.</p>` +
          `<label>Your password<input type="password" name="token" autocomplete="current-password" required></label>` +
          `<div class="sticky-actions"><button type="submit">Turn on</button></div></form>` +
          `<p class="meta"><a href="/settings">Back</a></p>`;
        return sendScreen(response, 200, screen("Approve from chat", html, { chrome: chromeFor(projectOf(who, request) ?? null, "settings") }));
      }
      if (!consumeApprovalNonce(body.get("nonce") ?? "", who.name, "chat-approval", body.get("digest") ?? "") || body.get("digest") !== digest) return refuse(response, who, 409, "That form is stale. Read the terms again.", "/settings");
      const proved = authenticateAccount(store, who.name, body.get("token") ?? "");
      if (!proved.ok || proved.role !== "approver" || proved.generation !== who.session.generation) return refuse(response, who, 403, "Turning on approving from chat takes your password, typed again.", "/settings");
      const saved = setChatApproval(store, { approver: who.name, scope, enabled: true, limits, via: "the console" }, now);
      return saved.ok ? redirect(response, `/settings?said=${encodeURIComponent(saved.said)}`) : refuse(response, who, 400, saved.message, "/settings");
    }

    if (url.pathname === "/settings/telegram/pair" || url.pathname === "/settings/telegram/unpair") {
      const body = readForm(posted, CONSOLE_FORMS.telegramPair);
      // The person's own pairing, under their password: a code minted for
      // them alone, or their own chats revoked. Teammates' pairings are
      // never touched from here.
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver can pair their own phone.", "/settings");
      const botId = options.telegramTokenFile === undefined ? null : loadBotToken(process.env, options.telegramTokenFile)?.botId ?? null;
      const show = (problem: string, status = 400) => sendScreen(response, status, screen("Telegram", telegramSettingsHtml(store, botId, who.name, who.session.csrf, { problem }), { chrome: chromeFor(projectOf(who, request) ?? null, "settings") }));
      if (body.getAll("password").length > 1) return show("Submit one value for each field.");
      if (botId === null) return show("Connect the Telegram bot first.", 409);
      const pairingIdentity = authenticateAccount(store, who.name, body.get("password") ?? "");
      if (!pairingIdentity.ok || pairingIdentity.role !== "approver" || pairingIdentity.generation !== who.session.generation) return show("Enter your Toolroll password to change your phone pairing.", 403);
      if (url.pathname.endsWith("/unpair")) {
        store.unpairTelegram(botId, who.name, now);
        return redirect(response, "/settings/telegram");
      }
      if (store.liveTelegramBindings(botId).some(binding => binding.approver === who.name)) return show("Your phone is already paired. Unpair it before pairing another.", 409);
      const code = mintPairingCode();
      store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who.name, by: who.name, ttlMs: PAIRING_TTL_MS }, now);
      return sendScreen(response, 200, screen("Pair Telegram", telegramSettingsHtml(store, botId, who.name, who.session.csrf, { code }), { chrome: chromeFor(projectOf(who, request) ?? null, "settings"), forceSensitive: true }));
    }

    if (["connect","pair","unpair","disconnect","alerts"].some(action => url.pathname === `/settings/teams/${action}`)) {
      const body = readForm(posted, CONSOLE_FORMS.teams);
      if (who.via !== "cookie" || who.role !== "approver" || restricted() || !options.configDir) return refuse(response, who, 403, "An installation approver can connect Teams.", "/settings");
      const dir = options.configDir, state = new ChatState(store, "teams"), action = url.pathname.split("/").at(-1);
      const show = (problem: string, status = 400) => sendScreen(response, status, screen("Teams", teamsSettingsHtml(store, dir, who.session.csrf, { problem, who: who.name, publicUrl: options.publicUrl ?? null }), { chrome: chromeFor(projectOf(who, request) ?? null, "settings") }));
      if ((["password", "app-id", "tenant", "secret"] as const).some(key => body.getAll(key).length > 1)) return show("Submit one value for each field.");
      const credentials = loadTeamsCredentials(dir);
      if (action === "alerts") {
        if (!credentials || !state.bindings(credentials.installation).some(one => state.live(one))) return show("Pair your Teams account first.", 409);
        savePrimary(dir, "teams"); return redirect(response, "/settings/teams");
      }
      if (!authenticateApprover(who, body.get("password") ?? "").ok) return show("Enter your Toolroll password to change Teams access.", 403);
      const generation = store.accountOf(who.name)!.generation;
      if (action === "connect") {
        try {
          const checked = await checkTeamsCredentials((body.get("app-id") ?? "").trim(), (body.get("tenant") ?? "").trim(), (body.get("secret") ?? "").trim(), options.teamsFetcher);
          const account = store.accountOf(who.name);
          if (account?.role !== "approver" || account.generation !== generation || account.revokedAt !== null) return show("Your access changed. Sign in again.", 403);
          if (credentials || loadTeamsCredentials(dir)) return show("Disconnect the current Teams app before connecting another.", 409);
          saveTeamsCredentials(dir, checked);
        } catch (error) { return show(error instanceof TeamsError ? error.message : "Teams could not be connected. Check the app id, tenant and secret."); }
      } else if (action === "disconnect") {
        if (credentials) state.revoke(credentials.installation, now);
        clearTeamsCredentials(dir);
      } else if (action === "unpair") {
        const mine = credentials ? state.bindings(credentials.installation).find(one => one.approver === who.name) : undefined;
        if (mine) state.revokeBinding(mine, now);
      } else if (action === "pair") {
        if (!credentials) return show("Connect your Teams app first.", 409);
        const mine = state.bindings(credentials.installation).find(one => one.approver === who.name);
        if (mine && state.live(mine)) return show("Your Teams account is already paired. Unpair it before pairing another.", 409);
        if (mine) state.revokeBinding(mine, now);
        const code = state.pairing(credentials.installation, who.name, generation, now);
        return sendScreen(response, 200, screen("Pair Teams", teamsSettingsHtml(store, dir, who.session.csrf, { code, who: who.name, publicUrl: options.publicUrl ?? null }), { chrome: chromeFor(projectOf(who, request) ?? null, "settings"), forceSensitive: true }));
      }
      return redirect(response, "/settings/teams");
    }

    if (["connect","pair","unpair","disconnect","alerts"].some(action=>url.pathname===`/settings/discord/${action}`)) {
      const body = readForm(posted, CONSOLE_FORMS.discord);
      if (who.via !== "cookie" || who.role !== "approver" || restricted() || !options.configDir) return refuse(response,who,403,"An installation approver can connect Discord.","/settings");
      const dir=options.configDir, state=new ChatState(store,"discord"), action=url.pathname.split("/").at(-1);
      const show=(problem:string,status=400)=>sendScreen(response,status,screen("Discord",discordSettingsHtml(store,dir,who.session.csrf,{problem,who:who.name}),{chrome:chromeFor(projectOf(who,request)??null,"settings")}));
      if ((["password","bot-token"] as const).some(key=>body.getAll(key).length>1)) return show("Submit one value for each field.");
      const credentials=loadDiscordCredentials(dir);
      if(action==="alerts") {
        if(!credentials || !state.bindings(credentials.installation).some(one=>state.live(one))) return show("Pair your Discord account first.",409);
        savePrimary(dir,"discord");return redirect(response,"/settings/discord");
      }
      if(!authenticateApprover(who, body.get("password")??"").ok) return show("Enter your Toolroll password to change Discord access.",403);
      const generation=store.accountOf(who.name)!.generation;
      if(action==="connect") {
        try {
          const checked=await checkDiscordCredentials((body.get("bot-token")??"").trim(),options.discordFetcher);
          const account=store.accountOf(who.name);
          if(account?.role!=="approver"||account.generation!==generation||account.revokedAt!==null) return show("Your access changed. Sign in again.",403);
          if(credentials || loadDiscordCredentials(dir)) return show("Disconnect the current Discord app before connecting another.",409);
          saveDiscordCredentials(dir,checked);
        } catch(error) {return show(error instanceof DiscordError?error.message:"Discord could not be connected. Check the token and try again.");}
      } else if(action==="disconnect") {
        if(credentials) state.revoke(credentials.installation,now);
        clearDiscordCredentials(dir);
      } else if(action==="unpair") {
        const mine=credentials?state.bindings(credentials.installation).find(one=>one.approver===who.name):undefined;
        if(mine) state.revokeBinding(mine,now);
      } else if(action==="pair") {
        if(!credentials) return show("Connect your Discord app first.",409);
        const mine=state.bindings(credentials.installation).find(one=>one.approver===who.name);
        if(mine&&state.live(mine)) return show("Your Discord account is already paired. Unpair it before pairing another.",409);
        if(mine) state.revokeBinding(mine,now);
        const code=state.pairing(credentials.installation,who.name,generation,now);
        return sendScreen(response,200,screen("Pair Discord",discordSettingsHtml(store,dir,who.session.csrf,{code,who:who.name}),{chrome:chromeFor(projectOf(who,request)??null,"settings"),forceSensitive:true}));
      }
      return redirect(response,"/settings/discord");
    }

    if (url.pathname === "/settings/messaging" && options.configDir !== undefined && options.telegramTokenFile !== undefined) {
      const body = readForm(posted, CONSOLE_FORMS.messaging);
      const wanted = (body.get("primary") ?? "").trim();
      const facts = effectivePrimary(process.env, options.configDir, loadBotToken(process.env, options.telegramTokenFile) !== null);
      // Only a CONFIGURED service may page — choosing silence is not a
      // selection, and an unconfigured primary would page nobody.
      if (!isMessagingChannel(wanted) || !facts.configured.includes(wanted)) {
        return refuse(response, who, 400, "primary must be one of the configured services");
      }
      savePrimary(options.configDir, wanted);
      return redirect(response, "/settings");
    }

    if (url.pathname === "/settings/permission-default" && options.telegramTokenFile !== undefined) {
      const body = readForm(posted, CONSOLE_FORMS.permissionDefault);
      const wanted = body.get("permission-mode");
      if (wanted !== "auto" && wanted !== "bypassPermissions") {
        return refuse(response, who, 400, "permissions must be Auto or Full access", "/settings");
      }
      store.setPermissionDefault(wanted, who.name, now);
      return redirect(
        response,
        `/settings?said=${encodeURIComponent(
          wanted === "bypassPermissions"
            ? "New tasks now start with Full access. Approved tasks keep their setting."
            : "New tasks now start with Auto. Approved tasks keep their setting.",
        )}`,
      );
    }

    if (url.pathname === "/settings/quality-default" && options.telegramTokenFile !== undefined) {
      const body = readForm(posted, CONSOLE_FORMS.qualityDefault);
      const wanted = body.get("quality-mode");
      if (!isQualityMode(wanted)) {
        return refuse(response, who, 400, "quality must be Default or Strict / release", "/settings");
      }
      store.setQualityDefault(wanted, who.name, now);
      return redirect(
        response,
        `/settings?said=${encodeURIComponent(
          wanted === "strict"
            ? "New tasks now use Strict / release. Approved tasks keep their setting."
            : "New tasks now use Default quality. Approved tasks keep their setting.",
        )}`,
      );
    }

    if (url.pathname === "/settings/notifications") {
      const body = readForm(posted, CONSOLE_FORMS.notifications);
      // Each person's own choice: a closed list of modes and a 24-hour HH:MM, or off.
      const mode = body.get("mode"), time = (body.get("digest") ?? "").trim(), shots = body.get("screenshots");
      if (mode !== null && mode !== "quiet" && mode !== "all") return refuse(response, who, 400, "choose Only when I'm needed or Every step", "/settings");
      if (time !== "" && time !== "off" && !isDigestTime(time)) return refuse(response, who, 400, "the evening digest time is HH:MM, or off", "/settings");
      if (shots !== null && !RESULT_SCREENSHOTS.includes(shots as ResultScreenshots)) return refuse(response, who, 400, "choose Off, First one or Up to 4", "/settings");
      const before = store.notificationPreference(who.name);
      const after = store.setNotificationPreference(who.name, { ...(mode === null ? {} : { mode }), ...(time === "" ? {} : { digestAt: time === "off" ? null : time }),
        ...(shots === null ? {} : { screenshots: shots as ResultScreenshots }) }, who.name, now);
      const said = after.mode !== before.mode
        ? after.mode === "quiet" ? "Chats now message you only when you're needed." : "Chats now message you at every step."
        : after.screenshots !== before.screenshots
        ? after.screenshots === "off" ? "Results arrive without screenshots." : `Results arrive with ${after.screenshots === "first" ? "their first screenshot" : "up to 4 screenshots"}.`
        : after.digestAt === null ? "Evening digest off." : `Evening digest at ${after.digestAt}.`;
      return redirect(response, `/settings?said=${encodeURIComponent(said)}`);
    }

    if (url.pathname === "/settings/notifications/mute") {
      const body = readForm(posted, CONSOLE_FORMS.notificationsMute);
      // Each person's own pings: a muted project stays in Tasks and the evening digest.
      const repo = body.get("repo") ?? "";
      const project = notificationProjects(store, who.name).find(one => one.repo === repo);
      if (project === undefined) return refuse(response, who, 400, "that project isn't one you can see", "/settings");
      const muted = body.get("pings") !== "on";
      store.setProjectMuted(who.name, repo, muted, now);
      return redirect(response, `/settings?said=${encodeURIComponent(muted ? `${project.name} muted. It still shows in Tasks and your evening digest.` : `${project.name} pings you again.`)}#notifications`);
    }

    if (url.pathname === "/settings/telegram-digest" && options.telegramTokenFile !== undefined) {
      const body = readForm(posted, CONSOLE_FORMS.telegramDigest);
      // The cadence is a closed list of minutes — never a free number from
      // a form; "off" clears it. Any approver session may set it.
      const wanted = (body.get("every") ?? "").trim();
      const allowed: Record<string, number | null> = { off: null, "30": 30, "60": 60, "240": 240, "720": 720, "1440": 1440 };
      if (!(wanted in allowed)) return refuse(response, who, 400, "the digest cadence is one of the listed choices", "/settings");
      const minutes = allowed[wanted] ?? null;
      store.setTelegramDigest(minutes === null ? null : minutes * 60_000, who.name, now);
      return redirect(response, `/settings?said=${encodeURIComponent(minutes === null ? "Digest off: each update arrives as it happens." : `Digest every ${minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}. Anything that needs you still arrives at once.`)}`);
    }

    if (url.pathname === "/settings/provider-key" || url.pathname === "/settings/provider-key-clear") {
      const body = readForm(posted, CONSOLE_FORMS.providerKey);
      // The central gate already required an ACTIVE approver; the value is
      // write-only from here — status pages say set/not-set, never bytes.
      const provider = body.get("provider") ?? "";
      if (!isProviderId(provider)) return refuse(response, who, 400, "unknown provider", "/settings");
      if (url.pathname === "/settings/provider-key-clear") {
        const cleared = clearProviderKey(provider, providerHome);
        const clearedMode = readAuthMode(provider, providerHome);
        return redirect(response, `/settings?said=${encodeURIComponent(
          !cleared
            ? "no stored key to remove"
            : clearedMode === "subscription"
              ? `the ${provider} key is removed — ${provider} uses its own login, so builds are unaffected`
              : `the ${provider} key is removed — an environment variable, if one exists, takes over`,
        )}`);
      }
      // Validate EVERYTHING before mutating anything (Codex round 5,
      // finding 2): an invalid key must never persist a mode change it
      // then hides, a mode equal to the current one is not a "change",
      // and an unchanged blank form does nothing.
      const wantedMode = body.get("auth-mode");
      const value = (body.get("value") ?? "").trim();
      const modeSelected = wantedMode === "subscription" || wantedMode === "api-key";
      const currentMode = readAuthMode(provider, providerHome);
      if (!modeSelected && value === "") {
        return refuse(response, who, 400, "nothing to change — paste a key or pick a sign-in", "/settings");
      }
      // A selected-but-inapplicable mode (openrouter subscription) refuses
      // before any write.
      if (modeSelected && wantedMode === "subscription" && !SUBSCRIPTION_CAPABLE[provider]) {
        return refuse(response, who, 409, `${provider} has no subscription login — it is API-key only`, "/settings");
      }
      // A present key must be plausible BEFORE the mode is touched.
      if (value !== "" && !plausibleKey(value)) {
        return refuse(response, who, 400, "that does not look like an API key — check the paste and try again", "/settings");
      }
      // Apply the mode only when it actually differs.
      const modeChanged = modeSelected && wantedMode !== currentMode;
      if (modeChanged) setAuthMode(provider, wantedMode as AuthMode, providerHome);
      const modeNote = modeChanged ? ` \u00b7 ${provider} now uses ${wantedMode === "api-key" ? "the API key" : "its own subscription / login"}` : "";
      if (value === "") {
        return redirect(response, `/settings?said=${encodeURIComponent(modeChanged ? `${provider} now uses ${wantedMode === "api-key" ? "the API key" : "its own subscription / login"}` : `no change — ${provider} already uses ${currentMode === "api-key" ? "the API key" : "its own subscription / login"}`)}`);
      }
      saveProviderKey(provider, value, providerHome); // known plausible
      // Verify right now, so a paste gets an immediate yes/no instead of a
      // failed build later. A stored-but-unreachable key still says so.
      // In API-key mode the account check tests the stored key, and remembers the answer until the key changes.
      const checked = readAuthMode(provider, providerHome) === "api-key" ? await connectionCheck(provider, true) : null;
      const verdict = checked?.verdict ?? await verifyProviderKey(provider, value);
      const stored = `the ${provider} key is stored`;
      return redirect(response, `/settings?said=${encodeURIComponent((verdict.ok ? `${stored} and verified — it works` : `${stored}. ${verdictWords(provider, verdict)}`) + modeNote)}`);
    }

    if (url.pathname === "/settings/telegram-token" && options.telegramTokenFile !== undefined) {
      const body = readForm(posted, CONSOLE_FORMS.telegramToken);
      const value = body.get("token") ?? "";
      const saved = saveBotToken(options.telegramTokenFile, value);
      if (!saved.ok) {
        const existing = loadBotToken({}, options.telegramTokenFile);
        const hasEnv = (envValue(process.env, "TELEGRAM_TOKEN") ?? "") !== "";
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return sendScreen(response, 400, settingsPage(chromeFor(who.via === "cookie" ? who.session.project : defaultProject, "settings"), existing, hasEnv, csrf, saved.message, options.configDir === undefined ? null : effectivePrimary(process.env, options.configDir, loadBotToken(process.env, options.telegramTokenFile) !== null), null, null, null, {
          ...store.permissionDefault(),
          canManage: who.role === "approver",
        }));
      }
      return redirect(response, "/settings");
    }

    // v87: the mail server Send email steps use, and a test email to its own address.
    if ((url.pathname === "/settings/email" || url.pathname === "/settings/email-test" || url.pathname === "/settings/email-read-test") && who.role === "approver" && options.configDir !== undefined) {
      const body = readForm(posted, CONSOLE_FORMS.email);
      const said = (words: string) => redirect(response, `/settings?said=${encodeURIComponent(words)}#email`);
      if (url.pathname === "/settings/email") {
        const saved = saveEmailSettings(options.configDir, { host: body.get("host"), port: body.get("port"), secure: body.get("secure"), user: body.get("user"), from: body.get("from"), password: body.get("password"), imapHost: body.get("imapHost"), imapPort: body.get("imapPort") });
        return said(saved.ok ? saved.said : saved.message);
      }
      if (url.pathname === "/settings/email-read-test") {
        // Sign in and open the inbox read-only, as an Inbox trigger's first check does: nothing is read or changed.
        const signed = await mailboxAccess(options.configDir, options.googleFetch ?? fetch);
        if (!signed.ok) return said(signed.said);
        const opened = await (options.flowTriggerIo?.mail ?? readThroughImap)(signed.access, "INBOX", null, 1);
        return said(opened.ok ? `Reading works: signed in to the inbox of ${signed.address}.` : opened.said);
      }
      const account = await sendingAccount(options.configDir, options.googleFetch ?? fetch);
      if (!account.ok) return said(account.said === "Email isn't set up yet. Add your mail server in Settings → Email." ? "Set up email first." : account.said);
      const settings = account.settings;
      const sent = await (options.mailSender ?? sendThroughServer)(settings, { from: settings.from, to: [settings.from], subject: "Toolroll: test email", text: "This is a test from Toolroll. Send email steps in your flows will come from this address." });
      return said(sent.ok ? `Sent a test email to ${settings.from}.` : sent.said);
    }

    // v89: a Google account for email: save the OAuth client and go to Google's consent screen, or disconnect.
    if ((url.pathname === "/settings/google" || url.pathname === "/settings/google/disconnect") && who.role === "approver" && options.configDir !== undefined) {
      const body = readForm(posted, CONSOLE_FORMS.google);
      const said = (words: string) => redirect(response, `/settings?said=${encodeURIComponent(words)}#email`);
      if (url.pathname === "/settings/google/disconnect") {
        await disconnectGoogle(options.configDir, options.googleFetch ?? fetch);
        return said("Google disconnected. Email goes through the mail server again, if one is set up.");
      }
      const saved = saveGoogleClient(options.configDir, { clientId: body.get("clientId"), clientSecret: body.get("clientSecret") });
      if (!saved.ok) return said(saved.message);
      const origin = consoleOrigin(request.headers.host);
      if (origin === null) return said("Connect Google from this computer (localhost) or from your https address.");
      const consent = googleConsent(readGoogleMail(options.configDir)!, `${origin}${GOOGLE_CALLBACK}`, who.name);
      for (const [key, visit] of googleVisits) if (visit.expires < Date.now()) googleVisits.delete(key);
      googleVisits.set(consent.visit.state, consent.visit);
      return goOutside(response, consent.url, "Going to Google to sign in…", { state: consent.visit.state, path: GOOGLE_CALLBACK, secure: origin.startsWith("https:") });
    }

    if (url.pathname === "/mode/confirm" || url.pathname === "/mode/sign") {
      const body = readForm(posted, CONSOLE_FORMS.mode);
      if (who.via !== "cookie") return refuse(response, who, 403, "signing a mode is a browser ceremony");
      const project = projectOf(who, request);
      if (project === null || project === undefined) {
        return refuse(response, who, 409, "open a project first — a mode is signed per repository", "/mode");
      }
      const name: ModeName = body.get("name") === "hands-off" ? "hands-off" : "standard";
      const days = Math.max(1, Math.min(MODE_MAX_DAYS, Math.floor(Number(body.get("days") ?? "1")) || 1));
      const expiry = new Date(now.getTime() + days * 24 * 60 * 60_000).toISOString();
      const preset = presetTerms(name, expiry);
      const terms: ModeTerms = {
        ...preset,
        autoApproveFiling: body.get("auto-approve") === "" || body.get("auto-approve") === null ? preset.autoApproveFiling : body.get("auto-approve") === "1",
        planAuto: body.get("plan-auto") === "1",
        reviewAuto: false,
        reviewRetryAuto: false,
        // The repair-auto grant is the SAME rule (v40): unchecked stays
        // false on every preset — only the explicit box grants it, and the
        // attempt cap it carries is meaningless without it.
        repairAuto: false,
        repairMaxAttempts: 0,
        // Approving from the paired chat: only the explicit choice grants it, naming every chat app it covers (a grant
        // signed before it named them stays Telegram only).
        chatApprove: body.get("chat-approve") === "1",
        ...(body.get("chat-approve") === "1" ? { chatApproveChats: CHAT_APPROVE_ALL } : {}),
        publication: body.get("publication") === "automerge" ? "automerge" : "notify",
      };
      if ((["review-auto", "review-retry-auto", "repair-auto"] as const).some(field => body.get(field) === "1")) {
        return refuse(response, who, 400, "Review scheduling and automatic revisions are no longer available. Reload the mode form.", "/mode");
      }
      if (terms.planAuto && !terms.autoApproveFiling) {
        return refuse(response, who, 400, "Automatic planner approval requires automatic filing approval.", "/mode");
      }
      if (terms.publication === "automerge" && !store.hasMergeCapableGrant(project, now)) {
        return refuse(response, who, 409, "self-merging needs a merge-capable publication grant first — grant one, then sign", "/mode");
      }
      const digest = modeDigestOf(terms);

      if (url.pathname === "/mode/confirm") {
        // THE CEREMONY (M1): every resolved term in words, and the password
        // signs exactly this digest — a drifted form refuses at /mode/sign.
        const nonce = mintApprovalNonce(who.name, "mode-sign", `${project}:${digest}`);
        const bodyHtml =
          `<h1 style="overflow-wrap:anywhere">Sign the ${escape(name)} mode for ${escape(project)}</h1>` +
          `<form method="post" action="/mode/sign" class="card approve-form">` +
          `<input type="hidden" name="csrf" value="${escape(who.session.csrf)}">` +
          `<input type="hidden" name="nonce" value="${escape(nonce)}">` +
          `<input type="hidden" name="digest" value="${escape(digest)}">` +
          (["name", "days", "publication", "auto-approve", "plan-auto", "chat-approve"] as const)
            .map(field => `<input type="hidden" name="${field}" value="${escape(body.get(field) ?? "")}">`)
            .join("") +
          `<input type="hidden" name="expiry" value="${escape(expiry)}">` +
          `<p><strong>Your password signs exactly this:</strong></p>` +
          modeWords(terms)
            .map(words => `<p class="recap" style="margin-top:.4rem">${escape(words)}</p>`)
            .join("") +
          `<label>Your password, typed again<input type="password" name="token" autocomplete="current-password"></label>` +
          `<div class="sticky-actions"><button type="submit">Sign it</button></div>` +
          `</form>` +
          `<p class="meta"><a href="/mode">back — sign nothing</a></p>`;
        return sendScreen(response, 200, screen("mode", bodyHtml, { chrome: chromeFor(project, "mode") }));
      }

      // /mode/sign: the fixed expiry rides the form; the digest is
      // RE-DERIVED from the posted fields — drift is a 409, never a guess.
      const fixedExpiry = body.get("expiry") ?? "";
      const signedTerms: ModeTerms = { ...terms, absoluteExpiry: fixedExpiry };
      const rederived = modeDigestOf(signedTerms);
      const nonce = body.get("nonce") ?? "";
      if (!consumeApprovalNonce(nonce, who.name, "mode-sign", `${project}:${body.get("digest") ?? ""}`)) {
        return refuse(response, who, 409, "that form is stale — read the terms again", "/mode");
      }
      if (rederived !== (body.get("digest") ?? "") || Date.parse(fixedExpiry) <= now.getTime()) {
        return refuse(response, who, 409, "the terms moved while you were reading — read them again", "/mode");
      }
      const token = body.get("token") ?? "";
      if (!authenticateApprover(who, token).ok) {
        return refuse(response, who, 403, "signing a mode takes your password, typed again", "/mode");
      }
      store.signMode(
        {
          repo: project,
          name: signedTerms.name,
          termsJson: modeTermsJson(signedTerms),
          digest: rederived,
          signedBy: who.name,
          absoluteExpiry: signedTerms.absoluteExpiry,
          publication: signedTerms.publication,
        },
        now,
      );
      return redirect(response, "/mode");
    }

    if (url.pathname === "/mode/revoke") {
      if (who.via !== "cookie") return refuse(response, who, 403, "ending a mode is a browser act");
      const project = projectOf(who, request);
      if (project === null || project === undefined) return refuse(response, who, 409, "open a project first", "/mode");
      // LOWERING authority is ONE CLICK for any approver (the v4 ruling):
      // csrf only, no password — the fastest possible off-switch.
      const ended = store.revokeMode(project, who.name, "operator", now);
      return redirect(response, ended ? "/mode?said=the%20mode%20is%20ended%20—%20every%20act%20falls%20back%20to%20its%20own%20ceremony" : "/mode");
    }
    // Turn the lead on with the agent signed in on this computer: its membership spends no dollars, so like starting a
    // conversation it needs no second password; the full form (Advanced) still asks for one.
    // Settings → Lead: the name and persona this person's lead speaks with.
    if (url.pathname === "/settings/lead/identity") {
      const body = readForm(posted, CONSOLE_FORMS.leadIdentity);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver names their lead.", "/settings/lead");
      const checked = checkLeadIdentity(body.get("name") ?? "", body.get("persona") ?? "");
      if (!checked.ok) return redirect(response, chatReturnWithSaid("/settings/lead", checked.message));
      store.setLeadConfig(who.name, checked.identity.name, checked.identity.persona, now);
      return redirect(response, "/settings/lead?saved=1");
    }
    // Settings → Lead: what this person's lead knows about them, one line each.
    if (url.pathname === "/settings/lead/about") {
      const body = readForm(posted, CONSOLE_FORMS.leadAbout);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver edits what their lead knows about them.", "/settings/lead");
      const checked = checkAboutYou(body.get("about") ?? "");
      if (!checked.ok) return redirect(response, chatReturnWithSaid("/settings/lead", checked.message));
      saveAboutYou(store, who.name, checked.lines, now);
      return redirect(response, "/settings/lead?saved=about");
    }
    // Settings → Lead: stop the lead following up on one of your promises.
    if (url.pathname === "/settings/lead/promise/cancel") {
      const body = readForm(posted, CONSOLE_FORMS.leadPromiseCancel);
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver manages the lead's promises.", "/settings/lead");
      const id = Number(body.get("promise"));
      const done = Number.isSafeInteger(id) && cancelCommitment(store, who.name, id, who.name, "Cancelled in Settings.", now);
      // The promise leaving the list says it was cancelled; only a refusal needs words.
      return redirect(response, done ? "/settings/lead" : chatReturnWithSaid("/settings/lead", "That promise was already closed."));
    }
    if (url.pathname === "/settings/lead/on") {
      if (who.via !== "cookie" || who.role !== "approver") return refuse(response, who, 403, "An approver turns the lead on.", "/settings/lead");
      await checkLocalAgents(true);
      const provider = runtime.localSignIn?.states.claude === "connected" ? "claude-subscription" : runtime.localSignIn?.states.codex === "connected" ? "codex-subscription" : null;
      if (provider === null) return redirect(response, chatReturnWithSaid("/settings/lead", `No agent is signed in on this computer yet. Run ${agentSignInCommand()}, then try again.`));
      store.setChatConfig({ provider, model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, who.name, now);
      return redirect(response, "/chat");
    }
    return refuse(response, who!, 404, "There's no page at this address.", "/chat");
  }

  /** Settings → Models, read from the saved catalog and the installation's role rows. */
  function modelsView(canManage: boolean, csrf: string, now: Date, said: string | null, problem: string | null) {
    const runtimes = runtimeStates(store);
    const installed = new Set(runtimes.map(one => one.tool));
    const openrouter = (readProviderKey("openrouter", providerHome) ?? process.env["OPENROUTER_API_KEY"] ?? "") !== "";
    const makers: { label: string; provider: ProviderId; on: boolean }[] = [
      { label: "Claude", provider: "claude", on: installed.has("claude") || runtimes.length === 0 },
      { label: "Codex", provider: "codex", on: installed.has("codex") },
      { label: "Gemini", provider: "gemini", on: installed.has("gemini") },
      { label: "OpenRouter", provider: "openrouter", on: openrouter },
    ];
    const build = store.phaseConfig(INSTALLATION_SCOPE, "build");
    const roles: RoleView[] = (["plan", "build", "review", "repair"] as const).map(phase => {
      const row = store.phaseConfig(INSTALLATION_SCOPE, phase);
      const groups = makers.filter(one => one.on && !(phase === "review" && one.provider === "gemini") && !(phase === "repair" && build !== null && one.provider !== build.provider))
        .map(one => ({ label: one.label, provider: one.provider, options: modelOptions(store, one.provider, now, providerHome) }));
      return {
        phase, label: ROLE_TITLES[phase], groups, ...(phase === "repair" ? { inherit: true } : {}),
        current: row === null ? (phase === "repair" ? "inherit" : "") : `${row.provider}|${row.model ?? ""}`,
        words: row === null ? (phase === "repair" ? "Same as the builder" : "Not set") : `${ASSISTANTS[row.provider as ProviderId]?.name ?? row.provider} · ${modelWords(store, row.provider, row.model)}`,
      };
    });
    const chat = store.getChatConfig();
    const chatName = chat === null ? "" : chat.provider === "claude-subscription" ? "Claude membership" : chat.provider === "codex-subscription" ? "Codex membership" : chat.provider === "anthropic-api" ? "Anthropic API" : "OpenRouter";
    return {
      runtimes, watch: watchState(store), roles, csrf, canManage, said, problem,
      chat: chat === null ? null : { words: `Leads and chat use ${chatName} · ${modelWords(store, chat.provider, chat.model)}` },
      fresh: (["claude", "codex", "gemini"] as const).flatMap(source => seenModels(store, source)).filter(model => isNewModel(model, now)).slice(0, 12),
    };
  }


  /** Google's redirect back: the code becomes a saved refresh token, and a page sends the person back to Settings. */
  async function googleCallback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const done = (said: string) => {
      const back = `/settings?said=${encodeURIComponent(said)}#email`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "set-cookie": signInSpent(GOOGLE_CALLBACK),
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${escape(back)}"><title>Toolroll</title>${HANDOFF_STYLE}<p>${escape(said)} <a href="${escape(back)}">Back to Settings</a></p>`);
    };
    const state = url.searchParams.get("state") ?? "";
    if (!startedHere(request, state)) return done("That Google sign-in was started in another browser. Connect again from this one.");
    const visit = googleVisits.get(state);
    googleVisits.delete(state);
    if (options.configDir === undefined || visit === undefined || visit.expires < Date.now() || store.accountOf(visit.by)?.role !== "approver") return done("That Google sign-in expired. Connect again from Settings.");
    if (url.searchParams.has("error")) return done(url.searchParams.get("error") === "access_denied" ? "Google wasn't connected: access was declined." : "Google wasn't connected.");
    const code = url.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9/_.~-]{10,1024}$/.test(code)) return done("Google didn't send a sign-in code. Connect again.");
    if (!adapterPolicy({ caller: "service", capability: "none" }).ok) return respond(response, 403, "text/plain", "Forbidden");
    const finished = await finishGoogleConsent(options.configDir, visit, code, options.googleFetch ?? fetch);
    return done(finished.ok ? `Connected ${finished.address}. Send email steps and Email inbox triggers use it now.` : finished.message);
  }

  async function connectCallback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const done = (back: string, key: "said" | "problem", words: string) => {
      const to = `${back}${back.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(words)}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "set-cookie": signInSpent(CONNECT_CALLBACK),
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${escape(to)}"><title>Toolroll</title>${HANDOFF_STYLE}<p>${escape(words)} <a href="${escape(to)}">Back to Toolroll</a></p>`);
    };
    const state = url.searchParams.get("state") ?? "";
    // Every arrival is logged (never the code or state): a sign-in that never came back is then visible as an absence.
    logEvent("info", "connect.callback", { error: url.searchParams.get("error"), known: connectVisits.has(state) });
    if (!startedHere(request, state)) return done("/settings/tools", "problem", "That sign-in was started in another browser. Connect again from this one.");
    const visit = connectVisits.get(state);
    connectVisits.delete(state);
    if (visit === undefined || visit.expires < Date.now() || store.accountOf(visit.by)?.role !== "approver") return done("/settings/tools", "problem", "That sign-in expired. Connect again.");
    const service = oneClickOf(visit.service)!;
    const kit = visit.kit === null ? null : kitOf(visit.kit);
    // Started from a gallery template's page: back to it, for the same project.
    const template = visit.template === null ? null : galleryTemplateOf(visit.template);
    const back = template !== null ? `/flows/new/${template.id}?repo=${encodeURIComponent(visit.repo)}`
      : kit === null ? `/settings/tools?repo=${encodeURIComponent(visit.repo)}` : `/kits/${kit.id}?repo=${encodeURIComponent(visit.repo)}`;
    const to = projectName(visit.repo);
    if (url.searchParams.has("error")) return done(back, "problem", url.searchParams.get("error") === "access_denied" ? `${service.label} wasn't connected to ${to}: access was declined.` : `${service.label} wasn't connected to ${to}.`);
    const code = url.searchParams.get("code") ?? "";
    if (!/^[\x21-\x7e]{4,2048}$/.test(code)) return done(back, "problem", `${service.label} didn't send a sign-in code. Connect again.`);
    const now = clock();
    if (!adapterPolicy({ caller: "service", capability: "none" }).ok) return respond(response, 403, "text/plain", "Forbidden");
    const finished = await finishConnect(store, visit, code, now, { fetcher: options.connectFetch ?? fetch, home: toolHome, omitEnv: ALL_CREDENTIAL_ENV });
    if (!finished.ok) return done(back, "problem", finished.said);
    // From a kit: its teammate may use the tool now (reading freely, the rest after a person approves each call).
    const set = kit === null || !kit.tools.some(one => one.tool === service.id) ? null : kitInstalled(store, kit, visit.repo);
    if (set !== null && store.teammateGrant(set.mate.id, service.id) === null) {
      const granted = await grantTool(store, set.mate, service.id, visit.by, now, { toolHome });
      if (granted.ok) return done(back, "said", `${service.label} is connected to ${to}, and ${nameOf(set.mate)} can use it: reading freely, the rest after you approve each call.`);
    }
    return done(back, "said", finished.said);
  }
  async function edge(ctx: EdgeContext): Promise<void> {
    if (ctx.route.id === 'edge.google-callback') return googleCallback(ctx.request, ctx.response, ctx.url);
    return connectCallback(ctx.request, ctx.response, ctx.url);
  }
  const registrations: Registration[] = [
    { id: "edge.google-callback", domain: "settings", stage: "edge", method: "GET", handle: edge },
    { id: "edge.connect-callback", domain: "settings", stage: "edge", method: "GET", handle: edge },
    { id: "spend", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "mode", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "control", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "control.connection", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.models", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.tools", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.project", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.approval", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.policy", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.integrations", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.monitoring", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.updates", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.retention", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.storage", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.pull-requests", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.checks", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.backups", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.data", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.sign-in", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.lead", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.teams", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.discord", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.slack", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.slack/manifest", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.skills", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.flows", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.knowledge", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.learning", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.telegram", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "settings.page", domain: "settings", stage: "console", method: "GET", handle: get },
    { id: "provider.resume", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.updates-dismiss", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.updates-checks", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.skills-revise", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.skills-import", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.skills-change", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "spend.budget", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.project-concurrency", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.project-delete", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.policy-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.approval-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.request-limits-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.sign-in-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.updates-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.updates-seen-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.updates-cancel-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.retention-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.storage-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.storage-clean-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.storage-discard-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.pull-requests-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.checks-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.backups-now-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.backups-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.data-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.integrations-test-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.monitoring-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.tools-connect-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.tools-change-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.appearance-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.flows-on", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.models-act", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.knowledge-refresh", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.knowledge-proposal", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.knowledge-decision", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.knowledge-change", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.learning-change", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "control.setup-preview", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "control.setup-approve", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "control.instructions-preview", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "control.instructions-approve", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.slack-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.teams-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.discord-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.telegram-retry", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.chat-approval-confirm", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.chat-approval-save", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.chat-approval-off", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.telegram-pair", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.telegram-unpair", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.messaging-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.permission-default-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.quality-default-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.notifications-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.notifications-mute-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.telegram-digest-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.provider-key-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.provider-key-clear-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.telegram-token-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.email-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.email-test-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.email-read-test-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.google-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.google-disconnect-send", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "mode.confirm", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "mode.sign", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "mode.revoke", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.lead-identity", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.lead-about", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.lead-promise-cancel", domain: "settings", stage: "console", method: "POST", handle: post },
    { id: "settings.lead-on", domain: "settings", stage: "console", method: "POST", handle: post },
  ];
  return { registrations, get, post, modelsView };
}
