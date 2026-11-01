/**
 * The eval and nightly enforcement hooks a release can't drop without a person (docs/plans/evals-nightly.md, part C,
 * "Policy code needs a person", Codex round 2 #10 and C1 round 1 #5, #6).
 *
 * The policy modules themselves are person-only by path (release-auto.ts autoPathProblem: `evals/`, `src/evals*.ts`,
 * `src/eval-*.ts`, `src/reviewer-evals.ts`, `src/nightly-github.ts`, `src/contracts/evals*.ts`, and the accounting
 * readings `src/reported-usage.ts` and `src/run-efficiency.ts`). The calls into them, and the store's accounting reads,
 * live in large product files that ship without a person, so rather than protect those files whole this manifest
 * lists each required call and the function it must be in (EVAL_HOOKS), and each function whose body a release may not
 * change by itself (EVAL_PINNED). The INSTALLED plane checks a candidate's tree against it (`evalHookProblem`, called
 * from release-auto.ts changeProblem): a listed call missing or moved out of its function, its function gone, a pinned
 * body changed, or a listed file that doesn't parse, needs a person. This file is itself a policy path.
 *
 * The check reads the syntax tree (TypeScript's own parser, the runtime dependency `typescript-parser`): only a real
 * call expression of that name inside that top-level function counts, never a comment, a string or a regular
 * expression. The name must also be bound to what the manifest says (`from`): an un-renamed named import from that
 * module, the file's own top-level function, or a local of the function itself, declared exactly once in the file and
 * never assigned (PR #263 review: a renamed import beside a local stand-in of the same name passed). Each enclosing
 * function and pinned body is held the same way, and a pinned `Class#method` is that class's one method of that name,
 * never assigned or redefined by name. With `args`, the call's arguments must read as the base has them. It proves
 * the call is in its function, not that it is reached (a call behind `if (false)` still reads as present); a person
 * reviewing a change to these files remains the backstop.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type ts from "typescript-parser";

let compiler: typeof ts | undefined;
const typescript = (): typeof ts => compiler ??= createRequire(import.meta.url)("typescript-parser") as typeof ts;

/** One required call: in this file, inside this top-level function, a call to this name, the name bound as `from`
 * says (a module specifier its un-renamed named import comes from; `self`: the file's own top-level function; `local`:
 * declared inside `inside`). `args`: the call's arguments, as text, must stay as the base has them. */
export type EvalHook = { file: string; inside: string; calls: string; from: string; args?: true; why: string };
/** One function whose body (its text, as the candidate has it) must stay as the base has it: a top-level function, or
 * `Class#method`, a method of a top-level class. */
export type EvalPinned = { file: string; fn: string; why: string };

export const EVAL_HOOKS: readonly EvalHook[] = Object.freeze([
  { file: "src/deploy-gate.ts", inside: "deploymentGate", calls: "nightlyDebtHold", from: "./nightly-github.js", why: "GitHub's nightly holds every deploy" },
  { file: "src/store.ts", inside: "reserveRelease", calls: "releaseNightlyProblem", from: "self", why: "GitHub's nightly holds the merge reservation" },
  { file: "src/store.ts", inside: "runReleaseOperation", calls: "releaseNightlyProblem", from: "self", why: "GitHub's nightly holds a reserved operation's start" },
  { file: "src/store.ts", inside: "releaseNightlyProblem", calls: "nightlyDebtHold", from: "./nightly-github.js", why: "the store's nightly check reads the debt" },
  { file: "src/release.ts", inside: "runRelease", calls: "nightlyHolds", from: "local", why: "GitHub's nightly holds deploy, merge and the tag" },
  { file: "src/release-adapters.ts", inside: "storeReleaseAdapter", calls: "nightlyBoundary", from: "./nightly-github.js", why: "the release's boundary read of GitHub's nightly" },
  { file: "src/release-auto.ts", inside: "sealAutoGreen", calls: "nightlyDebtHold", from: "./nightly-github.js", why: "GitHub's nightly holds automatic approval" },
  { file: "src/release-auto.ts", inside: "changeProblem", calls: "evalHookProblem", from: "./eval-hooks.js", why: "this check itself" },
  { file: "src/release-auto.ts", inside: "changeProblem", calls: "autoPathProblem", from: "self", why: "policy paths need a person" },
  { file: "src/release-auto.ts", inside: "changeProblem", calls: "storeRewriteProblem", from: "./eval-hooks.js", why: "no changed file rewrites a pinned Store method" },
  // The invocation gateway (invoke.ts): every agent run an eval world spawns takes a slot.
  { file: "src/invoke.ts", inside: "invokeAgent", calls: "takeEvalDispatch", from: "./eval-gate.js", why: "every agent dispatch in an eval world takes a slot" },
  // PR #263 review: what the run's billing basis and its unknown cost are computed from is held too, not only the call.
  { file: "src/invoke.ts", inside: "invokeAgent", calls: "recordRunBillingBasis", from: "./store.js", args: true, why: "a run's billing says whether it was known or guessed" },
  { file: "src/invoke.ts", inside: "invokeAgent", calls: "recordRunCostUnknown", from: "./store.js", args: true, why: "a run whose cost its provider never reported stays unknown money" },
  { file: "src/subscription-chat.ts", inside: "performSubscriptionLeadRequest", calls: "takeEvalDispatch", from: "./eval-gate.js", why: "every subscription lead request in an eval world takes a slot" },
  { file: "src/converse.ts", inside: "performLeadRequest", calls: "takeEvalDispatch", from: "./eval-gate.js", why: "every direct lead request in an eval world takes a slot" },
  { file: "src/converse.ts", inside: "performChatRequest", calls: "takeEvalDispatch", from: "./eval-gate.js", why: "every fleet chat request in an eval world takes a slot" },
  { file: "src/memory-pass.ts", inside: "defaultAnalyzer", calls: "inEvalWorld", from: "./eval-gate.js", why: "the memory pass makes no unrecorded call in an eval world" },
  { file: "src/task-sizing.ts", inside: "claudeSizer", calls: "inEvalWorld", from: "./eval-gate.js", why: "task sizing makes no unrecorded call in an eval world" },
  { file: "src/flow-draft.ts", inside: "claudeDraftRunner", calls: "inEvalWorld", from: "./eval-gate.js", why: "flow drafts make no unrecorded call in an eval world" },
  { file: "src/subagents.ts", inside: "claudeTurnRunner", calls: "inEvalWorld", from: "./eval-gate.js", why: "subagent turns make no unrecorded call in an eval world" },
  { file: "src/flow-sort.ts", inside: "askJev", calls: "inEvalWorld", from: "./eval-gate.js", why: "flow sort steps make no unrecorded call in an eval world" },
]);

export const EVAL_PINNED: readonly EvalPinned[] = Object.freeze([
  { file: "src/store.ts", fn: "runAccounting", why: "how a run's spending reads as API dollars, subscription usage or unknown" },
  { file: "src/store.ts", fn: "chatTurnAccounting", why: "how a chat request's spending reads" },
  { file: "src/store.ts", fn: "recordRunModelReported", why: "the exact model a run is held to its pin by" },
  { file: "src/store.ts", fn: "recordRunBillingBasis", why: "whether a run's billing was known" },
  { file: "src/store.ts", fn: "recordRunCostUnknown", why: "a run's unknown cost, once set, is never cleared" },
  // PR #263 review: the store's own writes of what a run or chat request spent.
  { file: "src/store.ts", fn: "Store#recordUsage", why: "what a run's provider said it cost" },
  { file: "src/store.ts", fn: "Store#settleRunSpend", why: "how a run's spending is priced" },
  { file: "src/store.ts", fn: "Store#fixRunBilling", why: "how a run was billed" },
  { file: "src/store.ts", fn: "Store#finalizeChatTurn", why: "what a chat request spent and how it was billed" },
  // PR #263 security scan: sealed on the prototype from the class's first static block (before any other code reaches
  // it), and locked on every instance by the constructor.
  { file: "src/store.ts", fn: "Store#static", why: "the pinned Store methods are sealed as the class is defined" },
  { file: "src/store.ts", fn: "Store#constructor", why: "each Store instance locks the pinned methods" },
  { file: "src/store.ts", fn: "sealStoreMoneyMethods", why: "the pinned Store methods can't be replaced at run time" },
  { file: "src/store.ts", fn: "lockStoreMoneyMethods", why: "the pinned Store methods can't be shadowed on an instance" },
]);

/** The Store methods pinned by body, which no file may write over (storeRewriteProblem, store.ts sealStoreMoneyMethods). */
export const PINNED_STORE_METHODS: readonly string[] = Object.freeze(EVAL_PINNED.filter(pin => pin.fn.startsWith("Store#") && pin.fn !== "Store#static" && pin.fn !== "Store#constructor")
  .map(pin => pin.fn.slice("Store#".length)));

type Parsed = { source: ts.SourceFile } | { problem: string };

/** A file's syntax tree, or why it can't be read (missing, or not valid TypeScript: a person decides). */
function parse(file: string, bytes: Buffer | null): Parsed {
  if (bytes === null) return { problem: `${file} can't be read` };
  const compiler = typescript();
  const source = compiler.createSourceFile(file, bytes.toString("utf8"), compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS);
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  return diagnostics.length === 0 ? { source } : { problem: `${file} doesn't parse` };
}

/** The one top-level function declaration with this name, or null when there is none or more than one. */
function topFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  const compiler = typescript();
  const found = source.statements.filter((one): one is ts.FunctionDeclaration => compiler.isFunctionDeclaration(one) && one.name?.text === name);
  return found.length === 1 ? found[0]! : null;
}

/** `Class#method`: the top-level class's one method of that name (no overload, accessor or property of it either),
 * never assigned or redefined by name anywhere in the file; null otherwise. `Class#constructor` is its one
 * constructor; `Class#static` its one static block, which must be the first of its static elements that runs code
 * (no static field initializer or other block runs before it). A class with a decorator anywhere (on it, a member or a
 * parameter: code that runs before the seal) holds none. */
function classMethod(source: ts.SourceFile, spec: string): ts.Node | null {
  const compiler = typescript();
  const [className, method] = spec.split("#") as [string, string];
  const classes = source.statements.filter((one): one is ts.ClassDeclaration => compiler.isClassDeclaration(one) && one.name?.text === className);
  if (classes.length !== 1 || hasDecorator(classes[0]!)) return null;
  if (method === "constructor") {
    const made = classes[0]!.members.filter(member => compiler.isConstructorDeclaration(member));
    return made.length === 1 && (made[0] as ts.ConstructorDeclaration).body !== undefined ? made[0]! : null;
  }
  if (method === "static") {
    const runs = classes[0]!.members.filter(member => compiler.isClassStaticBlockDeclaration(member)
      || (compiler.isPropertyDeclaration(member) && member.initializer !== undefined && (compiler.getModifiers(member) ?? []).some(one => one.kind === compiler.SyntaxKind.StaticKeyword)));
    const blocks = runs.filter(member => compiler.isClassStaticBlockDeclaration(member));
    return blocks.length === 1 && runs[0] === blocks[0] ? blocks[0]! : null;
  }
  const named = classes[0]!.members.filter(member => member.name !== undefined && (compiler.isIdentifier(member.name) || compiler.isStringLiteral(member.name)) && member.name.text === method);
  if (named.length !== 1 || !compiler.isMethodDeclaration(named[0]!) || named[0].body === undefined) return null;
  return memberRewritten(source, method) ? null : named[0];
}

/** Whether a decorator appears anywhere in this node. */
function hasDecorator(node: ts.Node): boolean {
  const compiler = typescript();
  if (compiler.isDecorator(node)) return true;
  let hit = false;
  compiler.forEachChild(node, one => { if (!hit && hasDecorator(one)) hit = true; });
  return hit;
}

/** The class header (modifiers, name, type parameters and heritage, up to its opening brace), whitespace normalized:
 * pinned with `Class#static`, so a changed `extends` or modifier needs a person. */
function classHeader(source: ts.SourceFile, node: ts.Node): string {
  const compiler = typescript();
  const owner = node.parent;
  if (!compiler.isClassDeclaration(owner)) return "";
  return source.text.slice(owner.getStart(source), owner.members.pos).replace(/\s+/g, " ").trim();
}

/** Whether the file writes a property of this name anywhere (`x.name = …`, `x["name"] = …`) or names it as a string to
 * a property-defining call (`Object.defineProperty(…, "name", …)`): a method so replaced isn't the body pinned. */
function memberRewritten(source: ts.SourceFile, name: string): boolean {
  const compiler = typescript();
  let hit = false;
  const visit = (one: ts.Node): void => {
    if (hit) return;
    if (compiler.isBinaryExpression(one) && isAssignment(one.operatorToken.kind)) {
      const left = one.left;
      if ((compiler.isPropertyAccessExpression(left) && left.name.text === name)
        || (compiler.isElementAccessExpression(left) && compiler.isStringLiteralLike(left.argumentExpression) && left.argumentExpression.text === name)) { hit = true; return; }
    }
    if (compiler.isCallExpression(one) && /define(Property|Properties)$|^assign$|setPrototypeOf$/.test(calleeName(one.expression))
      && one.arguments.some(argument => mentionsString(argument, name))) { hit = true; return; }
    compiler.forEachChild(one, visit);
  };
  visit(source);
  return hit;
}

function calleeName(node: ts.Expression): string {
  const compiler = typescript();
  return compiler.isIdentifier(node) ? node.text : compiler.isPropertyAccessExpression(node) ? node.name.text : "";
}

function mentionsString(node: ts.Node, text: string): boolean {
  const compiler = typescript();
  if ((compiler.isStringLiteralLike(node) && node.text === text) || (compiler.isIdentifier(node) && node.text === text)) return true;
  let hit = false;
  compiler.forEachChild(node, one => { if (!hit && mentionsString(one, text)) hit = true; });
  return hit;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  const compiler = typescript();
  return kind >= compiler.SyntaxKind.FirstAssignment && kind <= compiler.SyntaxKind.LastAssignment;
}

/** Every place in the file that binds or rebinds `name`: declarations of any kind (import specifiers, functions,
 * classes, variables, parameters, destructuring, catch variables, enums, namespaces, types) and assignments to it. */
function bindingsOf(source: ts.SourceFile, name: string): ts.Node[] {
  const compiler = typescript();
  const found: ts.Node[] = [];
  const assigned = (target: ts.Node): boolean => {
    if (compiler.isIdentifier(target)) return target.text === name;
    if (compiler.isParenthesizedExpression(target)) return assigned(target.expression);
    if (compiler.isObjectLiteralExpression(target)) return target.properties.some(one =>
      compiler.isShorthandPropertyAssignment(one) ? one.name.text === name
        : compiler.isPropertyAssignment(one) ? assigned(one.initializer)
        : compiler.isSpreadAssignment(one) ? assigned(one.expression) : false);
    if (compiler.isArrayLiteralExpression(target)) return target.elements.some(assigned);
    if (compiler.isSpreadElement(target)) return assigned(target.expression);
    if (compiler.isBinaryExpression(target) && target.operatorToken.kind === compiler.SyntaxKind.EqualsToken) return assigned(target.left);
    return false;
  };
  const visit = (one: ts.Node): void => {
    const declared = (one as { name?: ts.Node }).name;
    if (declared !== undefined && compiler.isIdentifier(declared) && declared.text === name && (
      compiler.isImportSpecifier(one) || compiler.isImportClause(one) || compiler.isNamespaceImport(one) || compiler.isImportEqualsDeclaration(one)
      || compiler.isFunctionDeclaration(one) || compiler.isFunctionExpression(one) || compiler.isClassDeclaration(one) || compiler.isClassExpression(one)
      || compiler.isVariableDeclaration(one) || compiler.isParameter(one) || compiler.isBindingElement(one)
      || compiler.isEnumDeclaration(one) || compiler.isModuleDeclaration(one) || compiler.isTypeAliasDeclaration(one) || compiler.isInterfaceDeclaration(one))) found.push(one);
    if (compiler.isBinaryExpression(one) && isAssignment(one.operatorToken.kind) && assigned(one.left)) found.push(one);
    if ((compiler.isPrefixUnaryExpression(one) || compiler.isPostfixUnaryExpression(one)) && compiler.isIdentifier(one.operand) && one.operand.text === name
      && (one.operator === compiler.SyntaxKind.PlusPlusToken || one.operator === compiler.SyntaxKind.MinusMinusToken)) found.push(one);
    if ((compiler.isForOfStatement(one) || compiler.isForInStatement(one)) && !compiler.isVariableDeclarationList(one.initializer) && assigned(one.initializer)) found.push(one);
    compiler.forEachChild(one, visit);
  };
  visit(source);
  return found;
}

/** Whether `name` is bound in this file only as `from` says: exactly one binding, and it is an un-renamed, value
 * (not type-only) named import from that module; the top-level function (`self`); or a declaration inside `inside`
 * (`local`). Null when it is; otherwise why not. */
function boundAs(source: ts.SourceFile, name: string, from: string, inside: ts.FunctionDeclaration): string | null {
  const compiler = typescript();
  const all = bindingsOf(source, name);
  if (all.length !== 1) return all.length === 0 ? `${name} isn't bound` : `${name} is declared or assigned more than once`;
  const only = all[0]!;
  if (from === "self") return compiler.isFunctionDeclaration(only) && only.parent === source ? null : `${name} isn't its own top-level function`;
  if (from === "local") return only.pos >= inside.pos && only.end <= inside.end && !compiler.isParameter(only) ? null : `${name} isn't declared inside ${inside.name?.text ?? "it"}`;
  if (!compiler.isImportSpecifier(only) || only.propertyName !== undefined || only.isTypeOnly) return `${name} isn't imported by its own name`;
  const clause = only.parent.parent;
  const declaration = clause.parent;
  if (clause.isTypeOnly || !compiler.isStringLiteral(declaration.moduleSpecifier) || declaration.moduleSpecifier.text !== from) return `${name} isn't imported from ${from}`;
  return null;
}

/** The call expressions in `node` whose callee is the plain identifier `name`. */
function callsOf(node: ts.Node, name: string): ts.CallExpression[] {
  const compiler = typescript();
  const found: ts.CallExpression[] = [];
  const visit = (one: ts.Node): void => {
    if (compiler.isCallExpression(one) && compiler.isIdentifier(one.expression) && one.expression.text === name) found.push(one);
    compiler.forEachChild(one, visit);
  };
  visit(node);
  return found;
}

/** A function the manifest names, held like a hook's callee: one top-level function, never rebound (a later
 * `name = …` would replace the body that was checked). */
function heldFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  const fn = topFunction(source, name);
  return fn === null || boundAs(source, name, "self", fn) !== null ? null : fn;
}

/** A reader that parses each file once. */
function parser(read: (file: string) => Buffer | null): (file: string) => Parsed {
  const seen = new Map<string, Parsed>();
  return file => { if (!seen.has(file)) seen.set(file, parse(file, read(file))); return seen.get(file)!; };
}

/** This hook as `tree` holds it: its calls' arguments as text (for `args`), or why it doesn't hold it. */
function hookIn(tree: (file: string) => Parsed, hook: EvalHook): { args: string[] } | { missing: string } {
  const parsed = tree(hook.file);
  if ("problem" in parsed) return { missing: `${parsed.problem}, and it holds a required call (${hook.why})` };
  const fn = heldFunction(parsed.source, hook.inside);
  if (fn === null || fn.body === undefined) return { missing: `${hook.file} no longer has ${hook.inside} as one function, which must call ${hook.calls} (${hook.why})` };
  const found = callsOf(fn.body, hook.calls);
  if (found.length === 0) return { missing: `${hook.file}'s ${hook.inside} no longer calls ${hook.calls} (${hook.why})` };
  const bound = boundAs(parsed.source, hook.calls, hook.from, fn);
  if (bound !== null) return { missing: `${hook.file}'s ${hook.inside} no longer calls the real ${hook.calls}: ${bound} (${hook.why})` };
  return { args: found.map(call => call.arguments.map(argument => argument.getText(parsed.source).replace(/\s+/g, " ")).join(", ")).sort() };
}

/** A pinned function's text in `tree`, or null when it can't be found once. */
function pinnedText(tree: (file: string) => Parsed, pin: EvalPinned): string | null {
  const parsed = tree(pin.file);
  if ("problem" in parsed) return null;
  const fn = pin.fn.includes("#") ? classMethod(parsed.source, pin.fn) : heldFunction(parsed.source, pin.fn);
  if (fn === null) return null;
  // The static block's pin holds the class header too: its name, modifiers and heritage, as the base has them.
  return pin.fn.endsWith("#static") ? `${classHeader(parsed.source, fn)}\n${fn.getText(parsed.source)}` : fn.getText(parsed.source);
}

/**
 * Why a candidate drops a required hook or changes a pinned body, or null. `candidate` gives a listed file's bytes at
 * the candidate (null: missing or unreadable, which needs a person too). With `base` (the plane's own record of where
 * the release started, which the candidate can't rewrite), only what the base holds is required: a project that isn't
 * Toolroll holds none, and a hook not yet landed can't be dropped.
 */
export function evalHookProblem(candidate: (file: string) => Buffer | null, base?: (file: string) => Buffer | null,
  hooks: readonly EvalHook[] = EVAL_HOOKS, pinned: readonly EvalPinned[] = EVAL_PINNED): string | null {
  const now = parser(candidate);
  const was = base === undefined ? null : parser(base);
  for (const hook of hooks) {
    const before = was === null ? null : hookIn(was, hook);
    if (before !== null && "missing" in before) continue;
    const after = hookIn(now, hook);
    if ("missing" in after) return after.missing;
    if (hook.args === true && before !== null && after.args.join("\n") !== before.args.join("\n")) return `${hook.file}'s ${hook.inside} changed what it passes to ${hook.calls} (${hook.why})`;
  }
  for (const pin of pinned) {
    const before = was === null ? null : pinnedText(was, pin);
    if (was !== null && before === null) continue;
    const after = pinnedText(now, pin);
    if (after === null) return `${pin.file} no longer has ${pin.fn} as one function (${pin.why})`;
    if (before !== null && after !== before) return `${pin.file}'s ${pin.fn} changed (${pin.why})`;
  }
  return null;
}

/** Every file the manifest reads, for one verified read of each tree. */
export const EVAL_HOOK_FILES: readonly string[] = Object.freeze([...new Set([...EVAL_HOOKS.map(hook => hook.file), ...EVAL_PINNED.map(pin => pin.file)])]);

/** Names whose every new mention in a changed file needs a person: the ways to define, reflect on, wrap or climb to
 * an object's class. */
const REFLECTIVE = new Set(["defineProperty", "defineProperties", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "assign", "setPrototypeOf", "getPrototypeOf",
  "__proto__", "__defineGetter__", "__defineSetter__", "Reflect", "Proxy", "constructor"]);
/** Built-ins whose members (`Object.x`, `Function.prototype.x`, ...) a changed file may never write: the store's seal
 * captures Object's at load, and nothing should replace them. */
const BUILTIN_HOLDERS = new Set(["Object", "Function"]);
const STORE_NAME = /store/i;
const GLOBAL_HOLDERS = new Set(["Object", "Reflect", "globalThis", "Store"]);

/**
 * The constructs that could reach a pinned Store method from another file, each as its whole normalized text (the
 * owner, 2026-10-31: one blunt rule, not a chase of syntax variants; store.ts's runtime seal is the other half):
 * a computed member name; a write through a computed element access; a computed element access on Object, Reflect,
 * globalThis or anything named store; any mention of a reflective name (REFLECTIVE, `.constructor` included); a class
 * whose `extends` isn't a plain identifier or names a store; any member, property or string named like a pinned
 * method that isn't a call of it; any decorator (it runs code as a class is defined); and any write to a member of
 * Object or Function (`Object.defineProperty = …`, `Function.prototype.call = …`).
 */
function storeRewrites(source: ts.SourceFile, pinned: readonly string[], ownClass: string | null): string[] {
  const compiler = typescript();
  const names = new Set(pinned);
  const found: string[] = [];
  const say = (node: ts.Node): void => { found.push(node.getText(source).replace(/\s+/g, " ")); };
  const computed = (one: ts.ElementAccessExpression): boolean => !compiler.isStringLiteralLike(one.argumentExpression) && !compiler.isNumericLiteral(one.argumentExpression);
  const writesThrough = (target: ts.Node): boolean => {
    if (compiler.isElementAccessExpression(target) && computed(target)) return true;
    let hit = false;
    if (compiler.isObjectLiteralExpression(target) || compiler.isArrayLiteralExpression(target) || compiler.isSpreadElement(target) || compiler.isSpreadAssignment(target)
      || compiler.isPropertyAssignment(target) || compiler.isShorthandPropertyAssignment(target) || compiler.isParenthesizedExpression(target)
      || (compiler.isBinaryExpression(target) && target.operatorToken.kind === compiler.SyntaxKind.EqualsToken)) {
      compiler.forEachChild(target, one => { if (!hit && writesThrough(one)) hit = true; });
    }
    return hit;
  };
  // A member of Object or Function anywhere along the access chain (`Object.x`, `globalThis.Object.x`,
  // `Function.prototype.x`, `Object["x"]`), or such a target inside a destructuring pattern.
  const writesBuiltin = (target: ts.Node): boolean => {
    if (compiler.isPropertyAccessExpression(target) || compiler.isElementAccessExpression(target)) {
      for (let holder: ts.Expression = target.expression; ; holder = (holder as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression) {
        while (compiler.isParenthesizedExpression(holder) || compiler.isNonNullExpression(holder) || compiler.isAsExpression(holder)) holder = holder.expression;
        if (compiler.isIdentifier(holder)) return BUILTIN_HOLDERS.has(holder.text);
        if (compiler.isPropertyAccessExpression(holder) && BUILTIN_HOLDERS.has(holder.name.text)) return true;
        if (compiler.isElementAccessExpression(holder) && compiler.isStringLiteralLike(holder.argumentExpression) && BUILTIN_HOLDERS.has(holder.argumentExpression.text)) return true;
        if (!compiler.isPropertyAccessExpression(holder) && !compiler.isElementAccessExpression(holder)) return false;
      }
    }
    let hit = false;
    if (compiler.isObjectLiteralExpression(target) || compiler.isArrayLiteralExpression(target) || compiler.isSpreadElement(target) || compiler.isSpreadAssignment(target)
      || compiler.isPropertyAssignment(target) || compiler.isShorthandPropertyAssignment(target) || compiler.isParenthesizedExpression(target)
      || (compiler.isBinaryExpression(target) && target.operatorToken.kind === compiler.SyntaxKind.EqualsToken)) {
      compiler.forEachChild(target, one => { if (!hit && writesBuiltin(one)) hit = true; });
    }
    return hit;
  };
  const writes = (target: ts.Node): boolean => writesThrough(target) || writesBuiltin(target);
  const visit = (one: ts.Node): void => {
    if (compiler.isComputedPropertyName(one)) say(one.parent);
    if (compiler.isDecorator(one)) say(one);
    if (compiler.isBinaryExpression(one) && isAssignment(one.operatorToken.kind) && writes(one.left)) say(one);
    if ((compiler.isPrefixUnaryExpression(one) || compiler.isPostfixUnaryExpression(one)) && (writesThrough(one.operand)
      || ((one.operator === compiler.SyntaxKind.PlusPlusToken || one.operator === compiler.SyntaxKind.MinusMinusToken) && writesBuiltin(one.operand)))) say(one);
    if (compiler.isDeleteExpression(one) && writes(one.expression)) say(one);
    if ((compiler.isForInStatement(one) || compiler.isForOfStatement(one)) && writes(one.initializer)) say(one);
    if (compiler.isElementAccessExpression(one) && computed(one)) {
      const holder = one.expression;
      const named = compiler.isIdentifier(holder) ? holder.text : compiler.isPropertyAccessExpression(holder) ? holder.name.text : "";
      if (GLOBAL_HOLDERS.has(named) || STORE_NAME.test(named)) say(one);
    }
    if ((compiler.isIdentifier(one) || compiler.isPrivateIdentifier(one) || compiler.isStringLiteralLike(one)) && REFLECTIVE.has(one.text)) say(one);
    if ((compiler.isClassDeclaration(one) || compiler.isClassExpression(one)) && one.heritageClauses !== undefined) {
      for (const clause of one.heritageClauses) {
        if (clause.token !== compiler.SyntaxKind.ExtendsKeyword) continue;
        for (const type of clause.types) if (!compiler.isIdentifier(type.expression) || STORE_NAME.test(type.expression.text)) say(clause);
      }
    }
    // Named like a pinned method: anything but calling it (`store.recordUsage(…)`) or referring to it.
    if ((compiler.isIdentifier(one) || compiler.isPrivateIdentifier(one) || compiler.isStringLiteralLike(one)) && names.has(one.text)) {
      const parent = one.parent;
      // store.ts's own declaration of the method (its body is pinned) is the one exempt construct.
      const own = ownClass !== null && compiler.isMethodDeclaration(parent) && parent.name === one && compiler.isClassDeclaration(parent.parent) && parent.parent.name?.text === ownClass
        && compiler.isSourceFile(parent.parent.parent);
      if (own) { compiler.forEachChild(one, visit); return; }
      const reference = compiler.isPropertyAccessExpression(parent) && parent.name === one
        && !(compiler.isBinaryExpression(parent.parent) && isAssignment(parent.parent.operatorToken.kind) && parent.parent.left === parent)
        && !((compiler.isPrefixUnaryExpression(parent.parent) || compiler.isPostfixUnaryExpression(parent.parent) || compiler.isDeleteExpression(parent.parent)));
      if (!reference) say(parent);
    }
    compiler.forEachChild(one, visit);
  };
  visit(source);
  return found;
}

/**
 * Why a changed file could write over a pinned Store method, or null (PR #263 security scan). Each changed JavaScript
 * or TypeScript file, store.ts included (its class's own method declarations exempt; their bodies are pinned), is held to
 * storeRewrites: a construct the base's copy of that file didn't already have (counted, by the sha256 of its whole
 * text) needs a person. A tree or file that can't be read, or a file that doesn't parse, needs one too; `paths` are the
 * files the verified diff says exist at the candidate, so no bytes is a failed read, never a deletion.
 */
export function storeRewriteProblem(paths: readonly string[], candidate: ((file: string) => Buffer | null) | null, base: ((file: string) => Buffer | null) | null,
  pinned: readonly string[] = PINNED_STORE_METHODS): string | null {
  const scanned = paths.filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path) && !path.startsWith("node_modules/") && !path.includes("/node_modules/"));
  if (scanned.length === 0) return null;
  if (candidate === null || base === null) return "the changed files can't be read";
  const key = (text: string): string => createHash("sha256").update(text).digest("hex");
  for (const path of scanned) {
    const bytes = candidate(path);
    if (bytes === null) return `${path} can't be read`;
    const now = parse(path, bytes);
    if ("problem" in now) return now.problem;
    const before = base(path);
    const was = before === null ? null : parse(path, before);
    const kept = new Map<string, number>();
    // store.ts is scanned too (its own method declarations exempt): nothing added there may reach a pinned method.
    const ownClass = path === "src/store.ts" ? "Store" : null;
    if (was !== null && !("problem" in was)) for (const one of storeRewrites(was.source, pinned, ownClass)) kept.set(key(one), (kept.get(key(one)) ?? 0) + 1);
    for (const one of storeRewrites(now.source, pinned, ownClass)) {
      const left = kept.get(key(one)) ?? 0;
      if (left > 0) { kept.set(key(one), left - 1); continue; }
      return `${path} adds \`${one.slice(0, 80)}\`, which could reach a pinned Store method`;
    }
  }
  return null;
}
