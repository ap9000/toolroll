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
/** `fn` may also be `outer>inner` (docs/plans/learning-loops.md, Protection 3): a `const inner = (…) => …` (or function
 * expression) or `function inner`, bound once in the file and never reassigned, inside the top-level function `outer`
 * and in no other function between them. `strict`: a base that holds the file but can't resolve the pin is a problem,
 * never skipped (a base without the file at all is a project that isn't Toolroll, and holds none). */
/** One function whose body (its text, as the candidate has it) must stay as the base has it: a top-level function, or
 * `Class#method`, a method of a top-level class. */
export type EvalPinned = { file: string; fn: string; why: string; strict?: true };

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
  { file: "src/release-auto.ts", inside: "changeProblem", calls: "learningHookProblem", from: "./eval-hooks.js", why: "learning loops' hooks, pins and writers (docs/plans/learning-loops.md)" },
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
function boundAs(source: ts.SourceFile, name: string, from: string, inside: ts.Node): string | null {
  const compiler = typescript();
  const all = bindingsOf(source, name);
  if (all.length !== 1) return all.length === 0 ? `${name} isn't bound` : `${name} is declared or assigned more than once`;
  const only = all[0]!;
  if (from === "self") return compiler.isFunctionDeclaration(only) && only.parent === source ? null : `${name} isn't its own top-level function`;
  if (from === "local") return only.pos >= inside.pos && only.end <= inside.end && !compiler.isParameter(only) ? null : `${name} isn't declared inside its function`;
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

/** `outer>inner`: the one function-like `inner` declared inside the held top-level `outer` (no other function between
 * them), bound once in the file and never reassigned — a `function inner` or a `const inner =` arrow or function
 * expression. Null otherwise. */
function nestedFunction(source: ts.SourceFile, spec: string): ts.FunctionLikeDeclaration | null {
  const compiler = typescript();
  const [outerName, innerName, ...rest] = spec.split(">");
  if (outerName === undefined || innerName === undefined || rest.length > 0 || outerName === "" || innerName === "") return null;
  const outer = heldFunction(source, outerName);
  if (outer === null || outer.body === undefined) return null;
  const all = bindingsOf(source, innerName);
  if (all.length !== 1) return null;
  const only = all[0]!;
  let fn: ts.FunctionLikeDeclaration | null = null;
  if (compiler.isFunctionDeclaration(only) && only.body !== undefined) fn = only;
  else if (compiler.isVariableDeclaration(only) && only.initializer !== undefined && (compiler.isArrowFunction(only.initializer) || compiler.isFunctionExpression(only.initializer))
    && compiler.isVariableDeclarationList(only.parent) && (only.parent.flags & compiler.NodeFlags.Const) !== 0) fn = only.initializer;
  if (fn === null) return null;
  // Directly inside `outer`: the first function-like ancestor of the declaration is `outer` itself.
  for (let at: ts.Node | undefined = only.parent; at !== undefined; at = at.parent) {
    if (at === outer) return fn;
    if (compiler.isFunctionLike(at) || compiler.isClassLike(at)) return null;
  }
  return null;
}

/** A held function by its manifest name: top-level, `Class#method` or `outer>inner`. */
function heldNode(source: ts.SourceFile, spec: string): ts.Node | null {
  if (spec.includes(">")) return nestedFunction(source, spec);
  if (spec.includes("#")) return classMethod(source, spec);
  return heldFunction(source, spec);
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
  const fn = (hook.inside.includes(">") ? nestedFunction(parsed.source, hook.inside) : heldFunction(parsed.source, hook.inside)) as ts.FunctionLikeDeclaration | null;
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
  const fn = heldNode(parsed.source, pin.fn);
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
    if (was !== null && before === null) {
      // A strict pin the base holds the file of but can't resolve is a problem (learning loops, Protection 2), never a skip.
      if (pin.strict === true && base!(pin.file) !== null) return `${pin.file} at the base has no ${pin.fn} as one function, which is pinned strictly (${pin.why})`;
      continue;
    }
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

// ---- learning loops (docs/plans/learning-loops.md, "Safety", Protection 2-4) ----------------------------------------

/** The calls that record a check's facts: at disposition, and as the check's command starts. */
export const LEARNING_HOOKS: readonly EvalHook[] = Object.freeze([
  { file: "src/builder.ts", inside: "settleProof", calls: "recordCheckFacts", from: "./check-facts.js", why: "every settled check records its facts" },
  { file: "src/builder.ts", inside: "settleProof>runVerification", calls: "captureCheckConditions", from: "./check-facts.js", why: "a check's conditions are captured as its command starts" },
]);

/** The bodies a release can't change by itself, every one strict: what a run is told from project memory, how a memory
 * proposal and a decision are written, and where a check's conditions are captured. */
export const LEARNING_PINNED: readonly EvalPinned[] = Object.freeze([
  { file: "src/project-knowledge.ts", fn: "knowledgeContext", strict: true, why: "the decisions and references a run is given, and their snapshot" },
  { file: "src/project-learning.ts", fn: "learningContext", strict: true, why: "the lessons a run is given, and their snapshot" },
  { file: "src/memory-pass.ts", fn: "decideProposal", strict: true, why: "a memory proposal's one writer" },
  { file: "src/project-memory.ts", fn: "recordDecision", strict: true, why: "how a decision is recorded and what it supersedes" },
  { file: "src/project-memory.ts", fn: "retireDecision", strict: true, why: "how a decision is retired" },
  { file: "src/builder.ts", fn: "settleProof>runVerification", strict: true, why: "the check's command and the conditions it starts under" },
]);

/** Every file the learning manifest reads. */
export const LEARNING_HOOK_FILES: readonly string[] = Object.freeze([...new Set([...LEARNING_HOOKS.map(hook => hook.file), ...LEARNING_PINNED.map(pin => pin.file)])]);

/** Each protected table and its only writer modules (the v149 migration in store.ts aside). The decision tables'
 * existing writers stay theirs: project-memory.ts records and retires, project-delete.ts deletes a whole project. */
export const LEARNING_WRITERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  check_fact: ["src/check-facts.ts"], check_result: ["src/check-facts.ts"],
  local_observation: ["src/flaky.ts"], ci_flaky_observation: ["src/flaky-ci.ts"], ci_pairing_rejected: ["src/flaky-ci.ts"],
  learning_watch: ["src/flaky.ts", "src/lesson-notes.ts"],
  lesson_note: ["src/lesson-notes.ts"], lesson_note_tally: ["src/lesson-notes.ts"],
  memory_use: ["src/memory-use.ts"],
  memory_tidy_proposal: ["src/memory-tidy.ts"], decision_merge: ["src/memory-tidy.ts"],
  project_decision: ["src/memory-tidy.ts", "src/project-memory.ts", "src/project-delete.ts"],
  decision_change: ["src/memory-tidy.ts", "src/project-memory.ts", "src/project-delete.ts"],
});
/** store.ts's v149 migration: the only place outside the writers that may name these tables in SQL. */
const LEARNING_MIGRATION: Readonly<Record<string, readonly string[]>> = Object.freeze({ "src/store.ts": ["V149_SCHEMA", "V149_TABLES", "V149_REPO_TABLES"] });

const PROTECTED = Object.keys(LEARNING_WRITERS);
const tableWrite = (table: string): RegExp => new RegExp(String.raw`(?:\b(?:(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:main\s*\.\s*)?["\`\[]?${table}["\`\]]?(?!\w)`
  + String.raw`|\b(?:DROP\s+(?:TABLE|TRIGGER|INDEX|VIEW)(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+(?:main\s*\.\s*)?["\`\[]?${table})`, "i");
const TABLE_WRITES = PROTECTED.map(table => ({ table, write: tableWrite(table) }));
const WRITE_WORD = /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i;
const BARE_NAME = new RegExp(String.raw`^\s*(?:main\s*\.\s*)?["\`\[]?(?:${PROTECTED.join("|")})["\`\]]?\s*$`, "i");

/** One SQL-shaped construct in a file: its static text (a placeholder `${}` where an expression sits), the protected
 * tables it writes, and the top-level declaration it's in ("" for none). `unreadable`: a write whose table name is
 * split around an expression; `bare`: a string that is only a protected table's name (SQL assembled elsewhere). */
type LearningConstruct = { text: string; tables: string[]; inside: string; unreadable: boolean; bare: boolean };

/**
 * Every construct in the file that could write a protected table: each string literal, template (its static parts)
 * and `+` concatenation (its literal operands), whatever it's passed to — `prepare`, `exec`, a renamed `prepare`, a
 * helper. A write verb next to a protected table's name, a table name split around an expression next to a write
 * word, and a string that is only a protected table's name are each found.
 */
export function learningConstructs(source: ts.SourceFile): LearningConstruct[] {
  const compiler = typescript();
  const found: LearningConstruct[] = [];
  const topOf = (node: ts.Node): string => {
    let at: ts.Node = node;
    while (at.parent !== undefined && !compiler.isSourceFile(at.parent)) at = at.parent;
    if (compiler.isFunctionDeclaration(at) || compiler.isClassDeclaration(at)) return at.name?.text ?? "";
    if (compiler.isVariableStatement(at)) return at.declarationList.declarations.map(one => compiler.isIdentifier(one.name) ? one.name.text : "").join(",");
    return "";
  };
  const fragmentRisk = (parts: readonly string[]): boolean => {
    // Around each placeholder: the identifier characters just before and just after it.
    for (let i = 0; i < parts.length - 1; i++) {
      const before = /[A-Za-z0-9_]*$/.exec(parts[i]!)![0].toLowerCase(), after = /^[A-Za-z0-9_]*/.exec(parts[i + 1]!)![0].toLowerCase();
      if (before === "" && after === "") continue;
      if (PROTECTED.some(table => (before !== "" && table.startsWith(before) && table !== before) || (after !== "" && table.endsWith(after) && table !== after)
        || (before !== "" && after !== "" && table.startsWith(before) && table.endsWith(after)))) return true;
    }
    return false;
  };
  const consider = (node: ts.Node, parts: readonly string[]): void => {
    const text = parts.join("${}");
    const tables = TABLE_WRITES.filter(one => one.write.test(text)).map(one => one.table);
    const unreadable = parts.length > 1 && WRITE_WORD.test(text) && fragmentRisk(parts);
    const bare = parts.length === 1 && BARE_NAME.test(text);
    if (tables.length > 0 || unreadable || bare) found.push({ text: text.replace(/\s+/g, " ").trim(), tables, inside: topOf(node), unreadable, bare });
  };
  const isPlus = (node: ts.Node): node is ts.BinaryExpression => compiler.isBinaryExpression(node) && node.operatorToken.kind === compiler.SyntaxKind.PlusToken;
  const flatten = (node: ts.Expression, into: ts.Expression[]): void => {
    let at: ts.Expression = node;
    while (compiler.isParenthesizedExpression(at)) at = at.expression;
    if (isPlus(at)) { flatten(at.left, into); flatten(at.right, into); } else into.push(at);
  };
  const visit = (node: ts.Node): void => {
    if (isPlus(node) && !(node.parent !== undefined && (isPlus(node.parent) || (compiler.isParenthesizedExpression(node.parent) && node.parent.parent !== undefined && isPlus(node.parent.parent))))) {
      const operands: ts.Expression[] = [];
      flatten(node, operands);
      if (operands.some(one => compiler.isStringLiteralLike(one) || compiler.isTemplateExpression(one))) {
        const parts: string[] = [""];
        for (const one of operands) {
          if (compiler.isStringLiteralLike(one)) parts[parts.length - 1] += one.text;
          else if (compiler.isTemplateExpression(one)) { parts[parts.length - 1] += one.head.text; for (const span of one.templateSpans) parts.push(span.literal.text); }
          else parts.push("");
        }
        if (parts.length > 1 || operands.length > 1) consider(node, parts);
      }
    }
    if (compiler.isStringLiteralLike(node)) consider(node, [node.text]);
    else if (compiler.isTemplateExpression(node)) consider(node, [node.head.text, ...node.templateSpans.map(span => span.literal.text)]);
    compiler.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether this construct may stand in this file: its writer module for every table it writes, or the migration's own
 * declarations in store.ts. An unreadable or bare construct stands only in a writer of some protected table. */
function learningAllowed(file: string, one: LearningConstruct): boolean {
  if ((LEARNING_MIGRATION[file] ?? []).some(name => one.inside.split(",").includes(name))) return true;
  if (one.tables.length > 0) return one.tables.every(table => LEARNING_WRITERS[table]!.includes(file));
  return Object.values(LEARNING_WRITERS).some(writers => writers.includes(file));
}

/**
 * Why a changed file writes a learning-loops table (or a decision merge or restore) from a place that may not, or null
 * (docs/plans/learning-loops.md, Protection 4). Every changed JavaScript or TypeScript file but tests is parsed; a
 * construct its writer module doesn't own is new unless the base's copy of that file already had exactly that text
 * (counted by its sha256, as storeRewriteProblem does). A file that can't be read or parsed needs a person. It reads
 * text the candidate wrote, never runs it: it raises the bar for review; a person reviewing these files is the backstop.
 */
export function learningWriteProblem(paths: readonly string[], candidate: ((file: string) => Buffer | null) | null, base: ((file: string) => Buffer | null) | null): string | null {
  const scanned = paths.filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path) && !path.startsWith("test/")
    && !path.startsWith("node_modules/") && !path.includes("/node_modules/"));
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
    if (was !== null && !("problem" in was)) for (const one of learningConstructs(was.source)) kept.set(key(one.text), (kept.get(key(one.text)) ?? 0) + 1);
    for (const one of learningConstructs(now.source)) {
      if (learningAllowed(path, one)) continue;
      const left = kept.get(key(one.text)) ?? 0;
      if (left > 0) { kept.set(key(one.text), left - 1); continue; }
      const what = one.unreadable ? "builds a learning-loops table's name around an expression in SQL" : one.bare ? "names a learning-loops table outside its writers" : "writes learning-loops rows outside their writers";
      return `${path} ${what} (\`${one.text.slice(0, 80)}\`)`;
    }
  }
  return null;
}

/**
 * Why a candidate needs a person for learning loops, or null: a required call dropped, a pinned body changed (strict
 * pins included), or a changed file writing a protected table from outside its writers. With `manifest.base`, only what
 * the base holds is required, as evalHookProblem does — except a strict pin whose file the base holds.
 */
export function learningHookProblem(
  manifest: { candidate: (file: string) => Buffer | null; base?: (file: string) => Buffer | null },
  changed: { paths: readonly string[]; candidate: ((file: string) => Buffer | null) | null; base: ((file: string) => Buffer | null) | null },
): string | null {
  return evalHookProblem(manifest.candidate, manifest.base, LEARNING_HOOKS, LEARNING_PINNED) ?? learningWriteProblem(changed.paths, changed.candidate, changed.base);
}
