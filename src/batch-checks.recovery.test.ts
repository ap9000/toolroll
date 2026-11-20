/** CH1b prospective admission only. Synthetic stores and recording runners; no model, Git or shell process. */
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { setProjectBatchChecks } from "./batch-policy.js";
import { queueBatchCheck, runBatchChecks } from "./batch-checks.js";
import { CHECK_RECOVERY_HELD, checkRequestDigest, representCheckHoldDetail } from "./check-recovery-hold.js";
import { recordRunCheckLevel } from "./check-levels.js";
import { CHECKS_REQUESTED, CHECKS_STARTED, CHECKS_FINISHED, FOLLOW_UP_LOG, FOLLOW_UP_RECEIPT } from "./result-follow-ups.js";
import type { Runner } from "./backend.js";
let dir: string | undefined, store: Store | undefined;
afterEach(()=>{ vi.restoreAllMocks(); store?.close(); store=undefined; if(dir) rmSync(dir,{recursive:true,force:true});dir=undefined; });
function world() {
 dir=realpathSync(mkdtempSync(join(tmpdir(),'batch-recovery-')));const repo=join(dir,'repo'),root=join(dir,'evidence'),scratch=join(dir,'scratch');mkdirSync(repo);mkdirSync(scratch);
 store=openStore(join(dir,'store.db'));const s=store,now=new Date('2026-11-20T00:00:00.000Z');
 const command=s.setVerifyCommand({repo,command:'echo synthetic-check',timeoutMs:60_000,approvedBy:'synthetic'},now);
 function member(name:string) {
  s.createTask({id:name,title:name},now);const ref=s.refFor('built-in',name).id;s.placeTask(ref,repo,{},now);
  const run=s.startRun({taskRef:ref,leaseId:'lease-'+name,runner:'synthetic',branch:'toolroll/'+name,worktree:join(dir!,name),route:{routeDigest:'legacy',phase:'build',provider:'codex',model:null,chosen:'legacy'},now});
  const head=(name==='one'?'a':'b').repeat(40);s.recordOutcomeFacts(run,{headRevision:head,handoff:'Synthetic result'});s.finishRun(run,{outcome:'built',committed:true,now});recordRunCheckLevel(s,{id:run,taskId:name,repo},'full','project',now);
  const input={runId:run,taskId:name,repo,head,base:'c'.repeat(40),command:s.liveVerifyCommand(repo)!};const request=queueBatchCheck(s,input,now);if(typeof request!=='number')throw Error('fixture');return {run,ref,head,request,input};
 }
 const calls:{kind:string;args:readonly string[]}[]=[];let afterGit:((args:readonly string[])=>void)|undefined,afterCommand:(()=>void)|undefined;
 const ok={code:0,stdout:'observed synthetic output',stderr:'',timedOut:false,notFound:false};
 const git:Runner=async(_file,args)=>{calls.push({kind:'git',args});if(args.includes('add'))mkdirSync(args[5]!,{recursive:true});afterGit?.(args);return {...ok,stdout:args.includes('rev-parse')?'f'.repeat(40):ok.stdout};};
 let commandCode=0;
 const runner:Runner=async(_file,args)=>{calls.push({kind:'command',args});afterCommand?.();return {...ok,code:commandCode};};
 function hold(m:ReturnType<typeof member>,invalid=false){const q=s.handle.prepare('SELECT * FROM action_ledger WHERE id=?').get(m.request)!;
  const digest=checkRequestDigest({id:q['id'],repo:q['repo'],runId:q['run_id'],taskId:q['task_id'],action:q['action'],outcome:q['outcome'],detail:q['detail']});if(digest===null)throw Error('digest');
  s.recordAction({at:now.toISOString(),actor:'toolroll',repo,taskId:m.input.taskId,runId:m.run,action:CHECK_RECOVERY_HELD,outcome:String(m.request),source:'work',detail:invalid?'{}':representCheckHoldDetail({v:1,q:digest,g:'d'.repeat(32),r:m.ref})!});
 }
 const events=(action:string)=>s.handle.prepare('SELECT * FROM action_ledger WHERE action=?').all(action);
 const run=(clock:()=>Date=()=>now)=>runBatchChecks(s,root,{git,runner,scratch,now:clock});
 return {s,repo,root,scratch,now,member,calls,hold,events,run,setCommandExit:(code:number)=>{commandCode=code;},setAfterGit:(f:typeof afterGit)=>{afterGit=f;},setAfterCommand:(f:typeof afterCommand)=>{afterCommand=f;}};
}

test.each([false,true])('held/invalid queue refuses existing dedup and appends no request (invalid=%s)',invalid=>{
 const w=world(),m=w.member('one');w.hold(m,invalid);const before=w.events(CHECKS_REQUESTED);
 expect(queueBatchCheck(w.s,m.input,w.now)).toMatchObject({state:'recovery-held',priorExecution:'unverified'});expect(w.events(CHECKS_REQUESTED)).toEqual(before);
});
test('no event preserves legacy lineage, queue and normal execution',async()=>{
 const w=world(),m=w.member('one');w.s.handle.prepare("UPDATE task_ref SET revision_of='missing-legacy-parent' WHERE id=?").run(m.ref);
 expect(queueBatchCheck(w.s,m.input,w.now)).toBe(m.request);expect(await w.run()).toBe(1);expect(w.calls.some(c=>c.kind==='command')).toBe(true);expect(w.events(CHECKS_FINISHED)).toHaveLength(1);
});
test('hold after cached cohort but before member claims produces no starts, scratch or executable calls',async()=>{
 const w=world(),a=w.member('one'),b=w.member('two'),live=w.s.liveVerifyCommand.bind(w.s);let n=0;setProjectBatchChecks(w.s,w.repo,true,'synthetic',w.now);
 vi.spyOn(w.s,'liveVerifyCommand').mockImplementation(repo=>{if(++n===3){w.hold(a);w.hold(b);}return live(repo);});
 expect(await w.run()).toBe(0);expect(w.calls).toEqual([]);expect(readdirSync(w.scratch)).toEqual([]);expect(w.events(CHECKS_STARTED)).toHaveLength(0);expect(w.events(CHECKS_FINISHED)).toHaveLength(0);
});
test('a held cached peer is excluded from tested membership and merged heads',async()=>{
 const w=world(),a=w.member('one'),b=w.member('two'),live=w.s.liveVerifyCommand.bind(w.s);let n=0;setProjectBatchChecks(w.s,w.repo,true,'synthetic',w.now);
 vi.spyOn(w.s,'liveVerifyCommand').mockImplementation(repo=>{if(++n===3)w.hold(a);return live(repo);});
 expect(await w.run()).toBe(1);expect(w.calls.flatMap(c=>c.args)).not.toContain(a.head);expect(w.calls.flatMap(c=>c.args)).toContain(b.head);
 const receipt=w.s.artifactsFor(b.run).find(x=>x.capture===FOLLOW_UP_RECEIPT)!;const parsed=JSON.parse(readFileSync(join(w.root,receipt.key),'utf8'));expect(parsed.batch.members.map((x:{task:string})=>x.task)).toEqual(['two']);expect(w.events(CHECKS_STARTED).map(x=>x['run_id'])).toEqual([b.run]);
});
test('hold after checkout stops later commands and retains factual output without finish or receipt',async()=>{
 const w=world(),m=w.member('one');w.setAfterGit(args=>{if(args.includes('add'))w.hold(m);});
 expect(await w.run()).toBe(0);expect(w.calls.filter(c=>c.kind==='command')).toEqual([]);expect(w.events(CHECKS_STARTED)).toHaveLength(1);expect(w.events(CHECKS_FINISHED)).toHaveLength(0);
 expect(w.s.artifactsFor(m.run).some(a=>a.capture===FOLLOW_UP_RECEIPT)).toBe(false);expect(w.s.artifactsFor(m.run).some(a=>a.capture===FOLLOW_UP_LOG)).toBe(true);expect(readdirSync(w.scratch)).toEqual([]);
});
test('hold observed after setup prevents check command and no not-run event is invented',async()=>{
 const w=world(),m=w.member('one');w.s.setWorktreeSetup({repo:w.repo,command:'echo synthetic-setup',timeoutMs:60_000,approvedBy:'synthetic'},w.now);w.setAfterCommand(()=>w.hold(m));
 expect(await w.run()).toBe(0);expect(w.calls.filter(c=>c.kind==='command')).toHaveLength(1);expect(w.events(CHECKS_FINISHED)).toHaveLength(0);expect(w.s.artifactsFor(m.run).some(a=>a.capture===FOLLOW_UP_RECEIPT)).toBe(false);
});
test('hold observed after an actual check preserves output, never manufactures finish or passed receipt',async()=>{
 const w=world(),m=w.member('one');w.setAfterCommand(()=>w.hold(m));expect(await w.run()).toBe(0);
 expect(w.calls.filter(c=>c.kind==='command')).toHaveLength(1);expect(w.events(CHECKS_FINISHED)).toHaveLength(0);expect(w.s.artifactsFor(m.run).some(a=>a.capture===FOLLOW_UP_RECEIPT)).toBe(false);
 const log=w.s.artifactsFor(m.run).find(a=>a.capture===FOLLOW_UP_LOG)!;expect(readFileSync(join(w.root,log.key),'utf8')).toContain('observed synthetic output');
});

test('hold committed at final seal reproof preserves observed command log without receipt or finish',async()=>{
 const w=world(),m=w.member('one');let seal=false;w.setAfterCommand(()=>{seal=true;});
 expect(await w.run(()=>{if(seal){seal=false;w.hold(m);}return w.now;})).toBe(0);
 expect(w.calls.filter(c=>c.kind==='command')).toHaveLength(1);expect(w.events(CHECKS_FINISHED)).toHaveLength(0);expect(w.s.artifactsFor(m.run).some(a=>a.capture===FOLLOW_UP_RECEIPT)).toBe(false);
 expect(w.s.artifactsFor(m.run).some(a=>a.capture===FOLLOW_UP_LOG)).toBe(true);
});

test('a hold committed during recursive split checkout starts no split check and fabricates no terminal result',async()=>{
 const w=world(),a=w.member('one');w.member('two');setProjectBatchChecks(w.s,w.repo,true,'synthetic',w.now);w.setCommandExit(1);let additions=0;
 w.setAfterGit(args=>{if(args.includes('add')&&++additions===2)w.hold(a);});
 expect(await w.run()).toBe(0);expect(w.calls.filter(c=>c.kind==='command')).toHaveLength(1);
 expect(additions).toBe(2);expect(w.events(CHECKS_FINISHED)).toHaveLength(0);
 expect(w.s.artifactsFor(a.run).some(x=>x.capture===FOLLOW_UP_RECEIPT)).toBe(false);expect(readdirSync(w.scratch)).toEqual([]);
});
