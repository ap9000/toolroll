import { describe, test, expect, vi } from "vitest";
import { fakePid } from "../test/fake-pid.js";
import { createHash } from "node:crypto";
import {
  cumulativeLiveResult,
  run, runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl, terminateLiveProviders, NOT_FOUND_CODE,
  JSONL_EVENT_HARD_CAP,
  retryTransientSpawn, isTransientSpawnFailure, type SpawnAttempt,
  agentNamed,
} from "./exec.js";
import * as processTree from "./process-tree.js";
import { adapterFor } from "./provider.js";

/** node itself is the one binary guaranteed to exist wherever these tests run. */
const NODE = process.execPath;

describe("run", () => {
  test("buffered group delivers large Unicode stdin completely and closes input", async () => {
    const input = "Unicode ✓ 😀\n".repeat(32_768);
    const result = await run(NODE, ["-e", "const h=require('node:crypto').createHash('sha256');process.stdin.on('data',x=>h.update(x));process.stdin.on('end',()=>console.log(h.digest('hex')));"], { processGroup: true, stdin: input, timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(createHash("sha256").update(input).digest("hex"));
  });
  test("buffered group refuses a closed stdin even when the child intends to exit zero", async () => {
    const result = await run(NODE, ["-e", "require('node:fs').closeSync(0);setTimeout(()=>process.exit(0),100);"], { processGroup: true, stdin: "x".repeat(2_000_000), timeoutMs: 10_000 });
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("prompt input failed");
  });
  test.each([run, runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl])("a late spawn fence creates no subprocess (%#)", async transport => {
    let spawned = false;
    const result = await transport(NODE, ["-e", "console.log('must not run')"], {
      processGroup: true, beforeSpawn: () => false, onSpawn: () => { spawned = true; },
    });
    expect(spawned).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
  });
  test.each([run, runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl])("a failed custody callback reaps the spawned child before returning (%#)", async transport => {
    let pid: number | null = null;
    const result = await transport(NODE, ["-e", "setInterval(()=>{},1000)"], {
      processGroup: true, timeoutMs: 10_000,
      onSpawn: value => { pid = value; throw new Error("cannot record provider custody"); },
    });
    expect(result).toMatchObject({ code: 1, timedOut: false, notFound: false });
    expect(result.stderr).toContain("cannot record provider custody");
    expect(pid).not.toBeNull();
    expect(() => process.kill(pid!, 0)).toThrow();
  });
  test.each([run, runStreamJsonl, runClaudeStreamJsonl, runGeminiStreamJsonl])("forwards exit-only observation diagnostics without an unknown spawn (%#)", async transport => {
    const diagnostic = vi.fn(), unknown = vi.fn();
    const observer = vi.spyOn(processTree, "observeProcessTree").mockImplementation((child, hooks) => {
      child.once("close", () => hooks.onObservationFailure?.({ phase: "final-exit", operation: "snapshot", code: "EMFILE", rootPid: child.pid ?? null, at: new Date().toISOString(), identityUnknown: false }));
    });
    try {
      await transport(NODE, ["-e", "process.exit(0)"], { processGroup: true, onObservationFailure: diagnostic, onUnknown: unknown });
      expect(diagnostic).toHaveBeenCalledOnce(); expect(unknown).not.toHaveBeenCalled();
    } finally { observer.mockRestore(); }
  });

  test("reports a non-zero exit as a result rather than throwing", async () => {
    // `git` fails routinely — outside a repo, on a bad ref. Failure is data.
    const result = await run(NODE, ["-e", "process.exit(3)"]);

    expect(result.code).toBe(3);
  });

  test("flags a missing binary instead of rejecting", async () => {
    // `gh` is absent on most machines; that must not end discovery
    const result = await run("standing-orders-no-such-binary", ["--version"]);

    expect(result.notFound).toBe(true);
    expect(result.code).toBe(NOT_FOUND_CODE);
  });

  test("kills a command that outruns its timeout and flags it", async () => {
    const result = await run(NODE, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 150 });

    expect(result.timedOut).toBe(true);
    expect(result.notFound).toBe(false);
    // One that survives SIGTERM is killed outright after the grace: its caller never waits forever.
    const stubborn = await run(NODE, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 500 });
    expect(stubborn.timedOut).toBe(true);
  });

  test("passes arguments verbatim, without shell interpretation", async () => {
    // A scanned directory may be named anything at all. Arguments are data.
    const hostile = "; rm -rf ~";

    const result = await run(NODE, ["-e", "process.stdout.write(process.argv[1])", hostile]);

    expect(result.stdout).toBe(hostile);
  });

});

describe("the provider process group (M6.12)", () => {
  test("an idle watchdog resets on observable progress and stops a silent provider", async () => {
    const progressing = await runStreamJsonl(
      process.execPath,
      ["-e", "let n=0;const t=setInterval(()=>{console.log(JSON.stringify({type:'thread.started',thread_id:String(++n)}));if(n===5){clearInterval(t);}},60)"],
      { idleTimeoutMs: 180, processGroup: true },
    );
    expect(progressing.timedOut).toBe(false);
    expect(progressing.code).toBe(0);
    expect(progressing.stdout).toContain('"thread_id":"5"');

    const silent = await runStreamJsonl(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      idleTimeoutMs: 150,
      processGroup: true,
    });
    expect(silent.timedOut).toBe(true);
  });

  test("a processGroup child's whole tree dies at the timeout — no orphaned grandchildren", async () => {
    // A parent that spawns a grandchild and exits nothing: without group
    // semantics, killing the parent leaves the grandchild running.
    const script = `
      const { spawn } = require("node:child_process");
      const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      console.log(JSON.stringify({ type: "thread.started", thread_id: String(grand.pid) }));
      setInterval(()=>{},1000);
    `;
    const result = await runStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 1_500,
      processGroup: true,
    });
    expect(result.timedOut).toBe(true);
    const grandPid = Number(/"thread_id":"(\d+)"/.exec(result.stdout)?.[1]);
    expect(Number.isInteger(grandPid)).toBe(true);
    // The grandchild must be gone. Wait for the kernel to reap it rather
    // than for a fixed beat a loaded machine can outlast; the bound only
    // ends a regression where it survives.
    const alive = (): boolean => {
      try {
        process.kill(grandPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const deadline = Date.now() + 10_000; alive() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
  });

  test("terminateLiveProviders ends a live provider now; the run settles as the failure it is", async () => {
    const pending = runStreamJsonl(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 60_000,
      processGroup: true,
    });
    // Let it spawn, then hard-stop.
    await new Promise(resolve => setTimeout(resolve, 200));
    const terminated = terminateLiveProviders();
    expect(terminated).toBeGreaterThan(0);
    const result = await pending;
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  // Release check 3261 was stored as "exit 1": a signal had ended it and the code alone said nothing of that.
  test("the buffered group transport keeps a signal apart from the exit, and says when its own hard stop ended it", async () => {
    const killed = await run(process.execPath, ["-e", "console.log('before'); process.kill(process.pid, 'SIGKILL')"], { processGroup: true, timeoutMs: 10_000 });
    expect(killed).toMatchObject({ code: 1, signal: "SIGKILL", timedOut: false });
    expect(killed.stoppedByPlane).toBeUndefined();
    expect((await run(process.execPath, ["-e", "process.exit(1)"], { processGroup: true, timeoutMs: 10_000 })).signal).toBeUndefined();
    const pending = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { processGroup: true, timeoutMs: 60_000 });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(terminateLiveProviders()).toBeGreaterThan(0);
    expect(await pending).toMatchObject({ stoppedByPlane: true, timedOut: false });
  });

  test("the buffered group transport keeps execFile's contract — output, timeout, not-found", async () => {
    const ok = await run(process.execPath, ["-e", "console.log('hi')"], { processGroup: true, timeoutMs: 10_000 });
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(ok.stdout).toContain("hi");

    const slow = await run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { processGroup: true, timeoutMs: 500 });
    expect(slow.timedOut).toBe(true);

    const missing = await run("definitely-not-a-binary-xyz", [], { processGroup: true, timeoutMs: 2_000 });
    expect(missing.notFound).toBe(true);
  });
});

describe("bounded provider JSONL replies", () => {
  const parseLines = (stdout: string): Record<string, unknown>[] =>
    stdout.split("\n").filter(line => line !== "").map(line => JSON.parse(line) as Record<string, unknown>);

  test("transport callbacks expose trimmed ids and retain bounded conflict witnesses", async () => {
    const codexIds: string[] = [];
    const codex = await runStreamJsonl(process.execPath, ["-e", `
      console.log(JSON.stringify({type:"thread.started",thread_id:"   "}));
      console.log(JSON.stringify({type:"thread.started",thread_id:"  codex-a  "}));
      console.log(JSON.stringify({type:"thread.started",thread_id:"  codex-b  "}));
    `], { timeoutMs: 15_000, onSessionId: id => codexIds.push(id) });
    expect(codexIds).toEqual(["codex-a", "codex-b"]);
    expect(parseLines(codex.stdout).filter(event => event["type"] === "thread.started")).toHaveLength(2);
    expect(adapterFor("codex").parse(codex.stdout)).toMatchObject({ sessionId: null, protocolError: expect.any(String) });

    const claudeIds: string[] = [];
    const claude = await runClaudeStreamJsonl(process.execPath, ["-e", `
      console.log(JSON.stringify({type:"system",subtype:"init",session_id:"   "}));
      console.log(JSON.stringify({type:"system",subtype:"init",session_id:"  claude-a  "}));
      console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-a"}));
      console.log(JSON.stringify({type:"system",subtype:"init",session_id:"  claude-b  "}));
      console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-c"}));
      console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"claude-a",result:"done"}));
    `], { timeoutMs: 15_000, onSessionId: id => claudeIds.push(id) });
    expect(claudeIds).toEqual(["claude-a", "claude-b"]);
    expect(parseLines(claude.stdout).filter(event => event["type"] === "system")).toHaveLength(3);
    expect(adapterFor("claude").parse(claude.stdout)).toMatchObject({
      sessionId: null,
      initObserved: true,
      protocolError: expect.stringMatching(/conflicting system\/init session ids/),
    });

    const geminiIds: string[] = [];
    const gemini = await runGeminiStreamJsonl(process.execPath, ["-e", `
      console.log(JSON.stringify({type:"init",session_id:"   ",model:"m"}));
      console.log(JSON.stringify({type:"init",session_id:"  gemini-a  ",model:"m"}));
      console.log(JSON.stringify({type:"init",session_id:"gemini-a",model:"m"}));
      console.log(JSON.stringify({type:"init",session_id:"  gemini-b  ",model:"m"}));
      console.log(JSON.stringify({type:"init",session_id:"gemini-c",model:"m"}));
      console.log(JSON.stringify({type:"result",status:"success"}));
    `], { timeoutMs: 15_000, onSessionId: id => geminiIds.push(id) });
    expect(geminiIds).toEqual(["gemini-a", "gemini-b"]);
    expect(parseLines(gemini.stdout).filter(event => event["type"] === "init")).toHaveLength(3);
    expect(adapterFor("gemini").parse(gemini.stdout)).toMatchObject({
      sessionId: null,
      initObserved: true,
      protocolError: expect.stringMatching(/conflicting init session ids/),
    });
  });

  test("codex retains a chunk-split reply whose escaped event is larger than 64 KiB", async () => {
    // The answer is 64 KiB, but quotes double on the wire. This is the
    // exact case the former serialized-line cap silently discarded.
    const answerBytes = 64 * 1024;
    const expected = "\"".repeat(answerBytes);
    const script = `
      const answer = '"'.repeat(${answerBytes});
      const line = JSON.stringify({type:"item.completed",item:{type:"agent_message",text:answer}});
      process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"codex-large"}) + "\\n");
      process.stdout.write(line.slice(0, 19));
      setTimeout(() => {
        process.stdout.write(line.slice(19, 70001));
        setTimeout(() => process.stdout.write(line.slice(70001) + "\\n"), 10);
      }, 10);
    `;

    const result = await runStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    const events = parseLines(result.stdout);
    const message = events.find(event => event["type"] === "item.completed");
    const item = message?.["item"] as Record<string, unknown> | undefined;

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeGreaterThan(64 * 1024);
    expect(item?.["text"]).toBe(expected);
    expect(adapterFor("codex").parse(result.stdout).finalMessage).toBe(expected);
  });

  test("claude retains an unterminated, chunk-split result larger than 64 KiB", async () => {
    const answerBytes = 64 * 1024;
    const expected = "\\".repeat(answerBytes);
    const script = `
      const answer = "\\\\".repeat(${answerBytes});
      const line = JSON.stringify({type:"result",subtype:"success",is_error:false,result:answer,session_id:"claude-large"});
      process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"claude-large"}) + "\\n");
      process.stdout.write(line.slice(0, 23));
      setTimeout(() => {
        process.stdout.write(line.slice(23, 70003));
        setTimeout(() => process.stdout.write(line.slice(70003)), 10);
      }, 10);
    `;

    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    const events = parseLines(result.stdout);
    const terminal = events.find(event => event["type"] === "result");

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(terminal), "utf8")).toBeGreaterThan(64 * 1024);
    expect(terminal?.["result"]).toBe(expected);
    expect(adapterFor("claude").parse(result.stdout).finalMessage).toBe(expected);
  });

  test("codex latches an event beyond the hard cap as failure even when a later message looks successful", async () => {
    const answerBytes = JSONL_EVENT_HARD_CAP + 1_337;
    const original = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "x".repeat(answerBytes) },
    });
    const script = `
      const line = JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"x".repeat(${answerBytes})}});
      process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"codex-overflow"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"earlier"}}) + "\\n");
      process.stdout.write(line.slice(0, 31));
      setTimeout(() => {
        process.stdout.write(line.slice(31) + "\\n");
        process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"later"}}) + "\\n");
        process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}) + "\\n");
      }, 10);
    `;

    const result = await runStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    const events = parseLines(result.stdout);
    const terminal = events.find(event => event["type"] === "turn.failed");
    const error = terminal?.["error"] as Record<string, unknown> | undefined;
    const receipt = JSON.parse(String(error?.["message"] ?? "")) as Record<string, unknown>;

    expect(error?.["type"]).toBe("standing-orders.stream-event-overflow");
    expect(receipt).toMatchObject({
      type: "standing-orders.stream-event-overflow",
      transport: "codex",
      eventBytesOriginal: Buffer.byteLength(original, "utf8"),
      hardCapBytes: JSONL_EVENT_HARD_CAP,
    });
    expect(receipt["prefix"]).toBe(original.slice(0, Number(receipt["prefixBytes"])));
    expect(Buffer.from(String(receipt["prefixBase64"]), "base64").toString("utf8")).toBe(receipt["prefix"]);
    expect(Buffer.byteLength(JSON.stringify(terminal), "utf8")).toBeLessThan(64 * 1024);
    expect(adapterFor("codex").parse(result.stdout)).toMatchObject({
      finalMessage: "later",
      structuralTerminal: { failed: true, code: "standing-orders.stream-event-overflow" },
    });
  });

  test.each(["type-first", "id-first", "type-last", "outer-last"])("codex drops oversized command telemetry with %s object keys", async (order) => {
    const script = `
      process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"codex-command-noise"}) + "\\n");
      const output='{"type":"item.completed","item":{"type":"agent_message"}}' + "q".repeat(${JSONL_EVENT_HARD_CAP + 2_000});
      const item=${JSON.stringify(order)}==='type-first'?{type:'command_execution',aggregated_output:output}:
        ${JSON.stringify(order)}==='id-first'?{id:'item_17',type:'command_execution',aggregated_output:output}:
        {id:'item_17',aggregated_output:output,type:'command_execution'};
      const event=${JSON.stringify(order)}==='outer-last'?{item,type:'item.completed'}:{type:'item.completed',item};
      const line=JSON.stringify(event)+'\\n';
      for(let i=0;i<line.length;i+=113) process.stdout.write(line.slice(i,i+113));
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}) + "\\n");
      process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}) + "\\n");
    `;

    const result = await runStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });

    expect(adapterFor("codex").parse(result.stdout)).toMatchObject({
      sessionId: "codex-command-noise",
      finalMessage: "done",
      structuralTerminal: null,
    });
  });

  test.each(["agent-last", "spoofed-nested", "duplicate-key", "malformed", "unknown-item"])("codex preserves overflow failure for %s", async (kind) => {
    const script = `
      const output='x'.repeat(${JSONL_EVENT_HARD_CAP + 2000});
      const kind=${JSON.stringify(kind)};
      let event={item:{text:output,type:'agent_message'},type:'item.completed'};
      if(kind==='spoofed-nested') event={data:{type:'item.completed',item:{type:'command_execution'}},item:{text:output,type:'agent_message'},type:'item.completed'};
      if(kind==='unknown-item') event={type:'item.completed',item:{type:'future_unknown',text:output}};
      let line=JSON.stringify(event);
      if(kind==='duplicate-key') line='{"type":"item.completed","item":{"type":"command_execution","text":'+JSON.stringify(output)+',"type":"agent_message"}}';
      if(kind==='malformed') line='{"type":"item.completed","item":{"type":"command_execution","text":'+JSON.stringify(output)+',"bad":1 2}}';
      process.stdout.write(line+'\\n');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'looks done'}})+'\\n');
      process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\\n');
    `;
    const result = await runStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    expect(adapterFor("codex").parse(result.stdout)).toMatchObject({
      structuralTerminal: { failed: true, code: "standing-orders.stream-event-overflow" },
    });
  });

  test("codex latches a truncated load-bearing event after init but still tolerates malformed telemetry", async () => {
    const malformed = '{"type":"turn.failed","error":{"message":"cut off"';
    const script = `
      process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"codex-malformed"}) + "\\n");
      process.stdout.write('{"type":"item.completed","item":{"type":"command_execution"' + "\\n");
      process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:1}}) + "\\n");
      process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"looks done"}}) + "\\n");
      process.stdout.write(${JSON.stringify(malformed)});
    `;

    const result = await runStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    const parsed = adapterFor("codex").parse(result.stdout);
    const failure = parseLines(result.stdout).find(event => {
      const error = event["error"] as Record<string, unknown> | undefined;
      return error?.["type"] === "standing-orders.stream-event-malformed";
    });
    const receipt = JSON.parse(String((failure?.["error"] as Record<string, unknown>)?.["message"] ?? "")) as Record<string, unknown>;

    expect(receipt).toMatchObject({
      type: "standing-orders.stream-event-malformed",
      transport: "codex",
      eventBytesOriginal: Buffer.byteLength(malformed, "utf8"),
      prefix: malformed,
    });
    expect(parsed).toMatchObject({
      finalMessage: "looks done",
      tokensIn: 2,
      structuralTerminal: { failed: true, code: "standing-orders.stream-event-malformed" },
    });
  });

  test("claude turns an event beyond the hard cap into an explicit error result", async () => {
    const answerBytes = JSONL_EVENT_HARD_CAP + 2_111;
    const original = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "y".repeat(answerBytes),
      session_id: "claude-overflow",
    });
    const script = `
      const line = JSON.stringify({type:"result",subtype:"success",is_error:false,result:"y".repeat(${answerBytes}),session_id:"claude-overflow"});
      process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"claude-overflow"}) + "\\n");
      process.stdout.write(line.slice(0, 29));
      setTimeout(() => {
        process.stdout.write(line.slice(29) + "\\n");
        process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"later"}) + "\\n");
      }, 10);
    `;

    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    const events = parseLines(result.stdout);
    const terminal = events.find(event => event["type"] === "result");
    const receipt = JSON.parse(String(terminal?.["result"] ?? "")) as Record<string, unknown>;

    expect(terminal).toMatchObject({
      subtype: "standing-orders-stream-event-overflow",
      is_error: true,
    });
    expect(receipt).toMatchObject({
      type: "standing-orders.stream-event-overflow",
      transport: "claude",
      eventBytesOriginal: Buffer.byteLength(original, "utf8"),
      hardCapBytes: JSONL_EVENT_HARD_CAP,
    });
    expect(receipt["prefix"]).toBe(original.slice(0, Number(receipt["prefixBytes"])));
    expect(Buffer.byteLength(JSON.stringify(terminal), "utf8")).toBeLessThan(64 * 1024);
    expect(adapterFor("claude").parse(result.stdout).finalMessage).toBe(terminal?.["result"]);
  });

  test("claude ignores an oversized non-result event when a valid primary result follows", async () => {
    const script = `
      process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"claude-child-noise"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"assistant",parent_tool_use_id:"tool-1",message:"z".repeat(${JSONL_EVENT_HARD_CAP + 2_000})}) + "\\n");
      process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done",session_id:"claude-child-noise"}) + "\\n");
    `;

    const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });

    expect(adapterFor("claude").parse(result.stdout)).toMatchObject({
      sessionId: "claude-child-noise",
      finalMessage: "done",
      structuralTerminal: null,
    });
  });

  test("claude never drops an oversized init that could hide a session conflict, in either event order", async () => {
    for (const late of [false, true]) {
      const script = `
        const init = JSON.stringify({type:"system",subtype:"init",session_id:"session-B",tools:"z".repeat(${JSONL_EVENT_HARD_CAP + 2_000})}) + "\\n";
        const result = JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done",session_id:"session-A",usage:{input_tokens:7,output_tokens:3}}) + "\\n";
        process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"session-A"}) + "\\n");
        process.stdout.write(${late ? "result + init" : "init + result"});
      `;

      const result = await runClaudeStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });

      expect(adapterFor("claude").parse(result.stdout)).toMatchObject({
        sessionId: "session-A",
        finalMessage: "done",
        tokensIn: 7,
        tokensOut: 3,
        structuralTerminal: { failed: true, code: "standing-orders-stream-event-overflow" },
      });
    }
  });
});


describe("the gemini retention runner (Phase 3 D1/A7)", () => {
  const emit = (lines: unknown[]): string =>
    `const lines=${JSON.stringify(lines.map(one => (typeof one === "string" ? one : JSON.stringify(one))))};for(const l of lines)console.log(l);`;

  const parseOut = (stdout: string): Record<string, unknown>[] =>
    stdout.split("\n").filter(one => one !== "").map(one => JSON.parse(one) as Record<string, unknown>);

  test("deltas assemble into ONE synthetic line the real CLI cannot emit", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit([
      "Loaded cached credentials.",
      { type: "init", session_id: "s-9", model: "m" },
      { type: "message", role: "user", content: "the brief" },
      { type: "message", role: "assistant", content: "part one ", delta: true },
      { type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: {} },
      { type: "tool_result", tool_id: "t1", status: "success" },
      { type: "message", role: "assistant", content: "part two", delta: true },
      { type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 2 } },
    ])], { timeoutMs: 15_000 });
    const kept = parseOut(result.stdout);
    expect(kept.map(one => one["type"])).toEqual(["init", "synthetic_message", "result"]);
    expect(kept[1]).toMatchObject({ content: "part one part two" });
  });

  test("REAL BYTES (S3, live spike 2026-08-29, gemini 0.57.0): the recorded happy-path stream assembles exactly", async () => {
    // Captured verbatim from a live API-key run — the fixture the spec
    // demanded once auth existed: real timestamps, real session id, real
    // delta framing. Note the live CLI emits SEPARATE assistant messages
    // both flagged delta:true (the haiku, then "done"); the runner's
    // concatenation rule is what makes the terminal message whole.
    const LIVE = [
    "{\"type\":\"init\",\"timestamp\":\"2026-08-29T17:38:58.092Z\",\"session_id\":\"b2e7f647-85e1-4c7e-a65c-0e914255ecbf\",\"model\":\"auto\"}",
    "{\"type\":\"message\",\"timestamp\":\"2026-08-29T17:38:58.093Z\",\"role\":\"user\",\"content\":\"Write a haiku about worktrees, then reply done\"}",
    "{\"type\":\"message\",\"timestamp\":\"2026-08-29T17:39:14.292Z\",\"role\":\"assistant\",\"content\":\"Branch in its own space,\\nNo need to stash or commit,\\nWork on both at once.\\n\\n\",\"delta\":true}",
    "{\"type\":\"message\",\"timestamp\":\"2026-08-29T17:39:14.299Z\",\"role\":\"assistant\",\"content\":\"done\",\"delta\":true}",
    "{\"type\":\"result\",\"timestamp\":\"2026-08-29T17:39:14.327Z\",\"status\":\"success\",\"stats\":{\"total_tokens\":9887,\"input_tokens\":8257,\"output_tokens\":60,\"cached\":4058,\"input\":4199,\"duration_ms\":16235,\"tool_calls\":0,\"models\":{\"gemini-3.1-flash-lite\":{\"total_tokens\":1640,\"input_tokens\":821,\"output_tokens\":37,\"cached\":0,\"input\":821},\"gemini-3.5-flash\":{\"total_tokens\":8247,\"input_tokens\":7436,\"output_tokens\":23,\"cached\":4058,\"input\":3378}}}}"
    ];
    // The captured lines are fed to the emitter AS OBJECTS parsed once —
    // no double round-trip claiming a fidelity the reserialize would break
    // (Codex gemini verify, finding 4). The bytes that matter are the
    // stream SHAPE and the assembled content, both asserted below.
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit(LIVE.map(one => JSON.parse(one)))], { timeoutMs: 15_000 });
    const kept = parseOut(result.stdout);
    expect(kept.map(one => one["type"])).toEqual(["init", "synthetic_message", "result"]);
    expect(kept[0]).toMatchObject({ session_id: "b2e7f647-85e1-4c7e-a65c-0e914255ecbf" });
    expect(kept[1]).toMatchObject({
      content: "Branch in its own space,\nNo need to stash or commit,\nWork on both at once.\n\ndone",
    });
    expect(kept[2]).toMatchObject({ status: "success" });
  });

  test("a non-delta assistant message REPLACES the buffer; non-string content is dropped", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit([
      { type: "init", session_id: "s", model: "m" },
      { type: "message", role: "assistant", content: "draft ", delta: true },
      { type: "message", role: "assistant", content: "the whole final message" },
      { type: "message", role: "assistant", content: { not: "a string" } },
      { type: "result", status: "success" },
    ])], { timeoutMs: 15_000 });
    const message = parseOut(result.stdout).find(one => one["type"] === "synthetic_message");
    expect(message).toMatchObject({ content: "the whole final message" });
  });

  test("the first error-severity line is retained; warnings and user echoes are not", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit([
      { type: "init", session_id: "s", model: "m" },
      { type: "error", severity: "warning", message: "loop detected" },
      { type: "error", severity: "error", message: "the real failure" },
      { type: "error", severity: "error", message: "a later failure" },
      { type: "result", status: "error" },
    ])], { timeoutMs: 15_000 });
    const kept = parseOut(result.stdout);
    const errors = kept.filter(one => one["type"] === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "the real failure" });
  });

  test("an oversized terminal result cannot be hidden by an earlier success", async () => {
    const original = JSON.stringify({
      type: "result",
      status: "error",
      error: { message: "g".repeat(JSONL_EVENT_HARD_CAP + 1_000) },
    });
    const script = `
      process.stdout.write(JSON.stringify({type:"init",session_id:"gemini-overflow",model:"m"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"result",status:"success"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"message",role:"assistant",content:"looks fine",delta:true}) + "\\n");
      process.stdout.write(JSON.stringify({type:"result",status:"error",error:{message:"g".repeat(${JSONL_EVENT_HARD_CAP + 1_000})}}) + "\\n");
    `;

    const result = await runGeminiStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    const parsed = adapterFor("gemini").parse(result.stdout);
    const terminal = parseOut(result.stdout).filter(event => event["type"] === "result").at(-1);
    const error = terminal?.["error"] as Record<string, unknown> | undefined;
    const receipt = JSON.parse(String(error?.["message"] ?? "")) as Record<string, unknown>;

    expect(terminal?.["status"]).toBe("standing-orders-stream-event-overflow");
    expect(receipt).toMatchObject({
      type: "standing-orders.stream-event-overflow",
      transport: "gemini",
      eventBytesOriginal: Buffer.byteLength(original, "utf8"),
      hardCapBytes: JSONL_EVENT_HARD_CAP,
    });
    expect(parsed).toMatchObject({
      finalMessage: "looks fine",
      promptConsumed: false,
      structuralTerminal: { failed: true, code: "standing-orders-stream-event-overflow" },
    });
  });

  test("a truncated result after init cannot be hidden by an earlier success, while malformed tool noise stays ignorable", async () => {
    const malformed = '{"type":"result","status":"error","error":{"message":"cut"';
    const script = `
      process.stdout.write("gemini startup prose\\n");
      process.stdout.write(JSON.stringify({type:"init",session_id:"gemini-malformed",model:"m"}) + "\\n");
      process.stdout.write('{"type":"tool_result","tool_id":"noise"' + "\\n");
      process.stdout.write(JSON.stringify({type:"message",role:"assistant",content:"looks fine",delta:true}) + "\\n");
      process.stdout.write(JSON.stringify({type:"result",status:"success",stats:{input_tokens:5,output_tokens:2}}) + "\\n");
      process.stdout.write(${JSON.stringify(malformed)});
    `;

    const result = await runGeminiStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 15_000 });
    const parsed = adapterFor("gemini").parse(result.stdout);
    const terminal = parseOut(result.stdout).filter(event => event["type"] === "result").at(-1);
    const receipt = JSON.parse(String((terminal?.["error"] as Record<string, unknown>)?.["message"] ?? "")) as Record<string, unknown>;

    expect(terminal?.["status"]).toBe("standing-orders-stream-event-malformed");
    expect(receipt).toMatchObject({
      type: "standing-orders.stream-event-malformed",
      transport: "gemini",
      eventBytesOriginal: Buffer.byteLength(malformed, "utf8"),
      prefix: malformed,
    });
    expect(parsed).toMatchObject({
      finalMessage: "looks fine",
      tokensIn: 5,
      promptConsumed: false,
      structuralTerminal: { failed: true, code: "standing-orders-stream-event-malformed" },
    });
  });

  test("a delta flood past the cap truncates with the marker and holds the line discipline", async () => {
    const script =
      `console.log(JSON.stringify({type:"init",session_id:"s",model:"m"}));` +
      `const chunk="ab\u00e9".repeat(1000);` + // multi-byte: the cap is bytes, not chars
      `for(let i=0;i<40;i++)console.log(JSON.stringify({type:"message",role:"assistant",content:chunk,delta:true}));` +
      `console.log(JSON.stringify({type:"result",status:"success"}));`;
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 20_000 });
    const message = result.stdout.split("\n").find(one => one.includes("synthetic_message"));
    expect(message).toBeDefined();
    expect(Buffer.byteLength(message as string, "utf8")).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(message as string) as { content: string; truncated?: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.content.endsWith("\u2026[truncated]")).toBe(true);
  });

  test("escaping-hostile content (quotes, backslashes, 4-byte unicode) still yields one parseable capped line", async () => {
    const script =
      `console.log(JSON.stringify({type:"init",session_id:"s",model:"m"}));` +
      `const chunk=('\\"\\\\'+String.fromCodePoint(0x1F680)).repeat(400);` +
      `for(let i=0;i<80;i++)console.log(JSON.stringify({type:"message",role:"assistant",content:chunk,delta:true}));` +
      `console.log(JSON.stringify({type:"result",status:"success"}));`;
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 20_000 });
    const message = result.stdout.split("\n").find(one => one.includes("synthetic_message"));
    expect(Buffer.byteLength(message as string, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(() => JSON.parse(message as string)).not.toThrow();
  });

  test("zero output stays zero output — exit code intact, nothing synthesized", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", "process.exit(41)"], { timeoutMs: 15_000 });
    expect(result.code).toBe(41);
    expect(result.stdout).toBe("");
  });

  test("a missing binary is NOT_FOUND, never a throw", async () => {
    const result = await runGeminiStreamJsonl("/no/such/gemini-binary", [], { timeoutMs: 5_000 });
    expect(result.notFound).toBe(true);
    expect(result.code).toBe(NOT_FOUND_CODE);
  });
});

describe("transient spawn failures are retried, bounded — a process that never started is not a result", () => {
  const failed = (code: string | number): SpawnAttempt => ({
    result: { code: 1, stdout: "", stderr: `spawn git ${code}`, timedOut: false, notFound: false },
    transient: isTransientSpawnFailure({ code }),
  });
  const ok: SpawnAttempt = { result: { code: 0, stdout: "main\n", stderr: "", timedOut: false, notFound: false }, transient: false };

  test("EAGAIN, EMFILE, and ENFILE are the transient class; exits, not-found, and timeouts are not", () => {
    expect(isTransientSpawnFailure({ code: "EAGAIN" })).toBe(true);
    expect(isTransientSpawnFailure({ code: "EMFILE" })).toBe(true);
    expect(isTransientSpawnFailure({ code: "ENFILE" })).toBe(true);
    expect(isTransientSpawnFailure({ code: "ENOENT" })).toBe(false);
    expect(isTransientSpawnFailure({ code: 1 })).toBe(false);
    expect(isTransientSpawnFailure({})).toBe(false);
    expect(isTransientSpawnFailure(null)).toBe(false);
  });

  test("two refused spawns then a start: three attempts, the delays honored in order, the real answer returned", async () => {
    const answers = [failed("EAGAIN"), failed("EMFILE"), ok];
    let attempts = 0;
    const slept: number[] = [];
    const result = await retryTransientSpawn(
      () => Promise.resolve(answers[attempts++] as SpawnAttempt),
      [10, 20, 30],
      ms => { slept.push(ms); return Promise.resolve(); },
    );
    expect(attempts).toBe(3);
    expect(slept).toEqual([10, 20]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("main\n");
  });

  test("a machine that never frees a slot: the delays run out and the last refusal stands, honestly", async () => {
    let attempts = 0;
    const result = await retryTransientSpawn(
      () => { attempts++; return Promise.resolve(failed("EAGAIN")); },
      [1, 1, 1],
      () => Promise.resolve(),
    );
    expect(attempts).toBe(4);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("EAGAIN");
  });

  test("a real failure is answered at once — no retry hides an exit code or a missing binary", async () => {
    let attempts = 0;
    const exit = await retryTransientSpawn(
      () => { attempts++; return Promise.resolve({ result: { code: 128, stdout: "", stderr: "fatal", timedOut: false, notFound: false }, transient: false }); },
      [1, 1],
      () => Promise.resolve(),
    );
    expect(attempts).toBe(1);
    expect(exit.code).toBe(128);
    let again = 0;
    const missing = await retryTransientSpawn(
      () => { again++; return Promise.resolve({ result: { code: NOT_FOUND_CODE, stdout: "", stderr: "", timedOut: false, notFound: true }, transient: false }); },
      [1, 1],
      () => Promise.resolve(),
    );
    expect(again).toBe(1);
    expect(missing.notFound).toBe(true);
  });
});

describe("a live Claude session's account across several results", () => {
  test("usage tokens and turns add up; the session, ending, words and running cost are the last result's", () => {
    const first = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s-1", num_turns: 3, total_cost_usd: 0.4,
      usage: { input_tokens: 120, output_tokens: 148, cache_creation_input_tokens: 900, cache_read_input_tokens: 4_000, service_tier: "standard" } };
    const second = { type: "result", subtype: "success", is_error: false, session_id: "s-1", result: "done", num_turns: 2, total_cost_usd: 0.55,
      usage: { input_tokens: 30, output_tokens: 50, cache_read_input_tokens: 6_000 } };
    const account = cumulativeLiveResult(first, second);
    expect(account).toMatchObject({ subtype: "success", is_error: false, result: "done", session_id: "s-1", total_cost_usd: 0.55, num_turns: 5,
      usage: { input_tokens: 150, output_tokens: 198, cache_creation_input_tokens: 900, cache_read_input_tokens: 10_000 } });
    // The parser reads the sum: the probe's Pause-then-note session recorded 50 output tokens instead of 198.
    expect(adapterFor("claude").parse(JSON.stringify(account))).toMatchObject({ tokensIn: 150, tokensOut: 198, costUsd: 0.55, ending: { subtype: "success", turns: 5 } });
    // A field that is not a non-negative number adds nothing; a result with no usage keeps the sum so far.
    expect(cumulativeLiveResult({ usage: { input_tokens: -5, output_tokens: "7" }, num_turns: null }, { usage: { input_tokens: 3 } }))
      .toMatchObject({ usage: { input_tokens: 3 } });
    expect(cumulativeLiveResult(second, { type: "result", subtype: "success" })).toMatchObject({ usage: { input_tokens: 30, output_tokens: 50 }, num_turns: 2 });
  });
});

describe("finding the agent's own process in a listing", () => {
  test("by its listed name, or on Linux by its program when the listing shows Node 24's \"MainThread\"", () => {
    const programs: Record<number, string> = { [fakePid(2)]: "node", [fakePid(3)]: "bwrap" };
    const programOf = (pid: number) => programs[pid] ?? null;
    expect(agentNamed({ pid: fakePid(1), name: "agent.mjs" }, ["node", "agent.mjs"], programOf)).toBe(true);
    expect(agentNamed({ pid: fakePid(2), name: "MainThread" }, ["node", "agent.mjs"], programOf)).toBe(true);
    // A wrapper on the way (bubblewrap) is never taken for it, by name or program.
    expect(agentNamed({ pid: fakePid(3), name: "bwrap" }, ["node", "agent.mjs"], programOf)).toBe(false);
    expect(agentNamed({ pid: fakePid(4), name: "MainThread" }, ["opencode"], programOf)).toBe(false);
  });

  test.skipIf(process.platform !== "linux")("on Linux a running Node process is found by its program", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    try {
      await new Promise(done => setTimeout(done, 300));
      expect(agentNamed({ pid: child.pid!, name: "MainThread" }, [process.execPath.split("/").pop()!])).toBe(true);
    } finally { child.kill("SIGKILL"); }
  });
});

// Evals B1/C1 Codex round 1 #7: one session whose inits name two models keeps both through the transport, so the run's
// model reads unknown (never the pinned one); inits that agree keep their model.
test.each([
  ["claude-opus-4-1-20250805", null, false],
  ["claude-sonnet-5-5", "claude-sonnet-5-5", false],
  ["claude-opus-4-1-20250805", null, true],
  ["claude-sonnet-5-5", "claude-sonnet-5-5", true],
])("the Claude transport keeps a second init naming %s: the reported model is %s (earlier unnamed init: %s)", async (second, expected, unnamed) => {
  const result = await runClaudeStreamJsonl(process.execPath, ["-e", `
    ${unnamed ? 'console.log(JSON.stringify({type:"system",subtype:"init",session_id:"s-1"}));' : ""}
    console.log(JSON.stringify({type:"system",subtype:"init",session_id:"s-1",model:"claude-sonnet-5-5"}));
    console.log(JSON.stringify({type:"system",subtype:"init",session_id:"s-1",model:${JSON.stringify(second)}}));
    console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"s-1",result:"done",total_cost_usd:0.01,num_turns:1}));
  `], { timeoutMs: 15_000 });
  expect(adapterFor("claude").parse(result.stdout).modelReported ?? null).toBe(expected);
});
