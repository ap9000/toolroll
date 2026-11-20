/** CH2a hard Full gate and followed-PR reservation only; synthetic store and recording exec, no network. */
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './store.js';
import { recordRunCheckLevel } from './check-levels.js';
import { fullCheckGate } from './result-follow-ups.js';
import { mergePullRequest, pullRequestViewOf, followPullRequests, savePublishing } from './pull-request-flow.js';
import { CHECK_RECOVERY_HELD, checkRequestDigest, representCheckHoldDetail } from './check-recovery-hold.js';
import type { PublishExec } from './publish.js';
let dir:string|undefined,s:Store|undefined;
afterEach(()=>{s?.close();s=undefined;if(dir)rmSync(dir,{recursive:true,force:true});dir=undefined;});
function world(level:'full'|'off'|null='full',repoPresent=true) {
 dir=realpathSync(mkdtempSync(join(tmpdir(),'pr-recovery-')));s=openStore(join(dir,'store.db'));const store=s,now=new Date('2026-11-20T00:00:00.000Z'),repo=join(dir,'project'),head='a'.repeat(40);mkdirSync(repo);
 store.createTask({id:'synthetic',title:'Synthetic saved result'},now);const ref=store.refFor('built-in','synthetic').id;store.placeTask(ref,repoPresent?repo:null,{},now);
 const run=store.startRun({taskRef:ref,leaseId:'synthetic',runner:'synthetic',branch:'toolroll/synthetic',worktree:join(dir,'checkout'),route:{routeDigest:'legacy',phase:'build',provider:'codex',model:null,chosen:'legacy'},now});
 store.recordOutcomeFacts(run,{headRevision:head,handoff:'Actual saved output'});store.finishRun(run,{outcome:'built',committed:true,now});
 if(level!==null)recordRunCheckLevel(store,{id:run,taskId:'synthetic',repo:repoPresent?repo:null},level,'project',now);
 store.recordRunCheck(run,{status:'passed',exitCode:0,suites:[]},now);
 savePublishing(store,{repo,githubRepo:'synthetic/example',remote:'origin',base:'main',account:'synthetic'},'synthetic',{mergeWhenGreen:true},now);
 const publication=store.createPublicationIntent({run,taskRef:ref,githubRepo:'synthetic/example',remote:'origin',base:'main',head:'toolroll/synthetic',headSha:head,bodyHash:'synthetic',draft:false},now);store.markPublicationPushed(publication,now);store.markPublicationOpened(publication,12,'https://github.com/synthetic/example/pull/12',now);store.recordPublicationCheckState(publication,'passing',now);
 store.handle.prepare('INSERT INTO pull_request_follow(publication,created_at,updated_at) VALUES (?,?,?)').run(publication,now.toISOString(),now.toISOString());
 const qrepo=repoPresent?repo:null,detail=`${head} · person · ${'b'.repeat(16)}`;
 const request=store.recordAction({at:now.toISOString(),actor:'synthetic',repo:qrepo,taskId:'synthetic',runId:run,action:'checks requested',outcome:'full',source:'work',detail});
 const digest=checkRequestDigest({id:request,repo:qrepo,taskId:'synthetic',runId:run,action:'checks requested',outcome:'full',detail})!;
 const hold=(invalid=false)=>store.recordAction({at:now.toISOString(),actor:'toolroll',repo:qrepo,taskId:'synthetic',runId:run,action:CHECK_RECOVERY_HELD,outcome:String(request),source:'work',detail:invalid?'{}':representCheckHoldDetail({v:1,q:digest,g:'c'.repeat(32),r:ref})!});
 const calls:readonly string[][]=[];let merged=false;const exec:PublishExec=async(file,args)=>{(calls as string[][]).push([file,...args]);if(args[1]==='merge')merged=true;return {code:0,stdout:JSON.stringify({state:merged?'MERGED':'OPEN',isDraft:false,headRefOid:head,statusCheckRollup:[{__typename:'CheckRun',name:'synthetic',status:'COMPLETED',conclusion:'SUCCESS'}],mergeCommit:merged?{oid:'d'.repeat(40)}:null,baseRefName:'main',url:'https://github.com/synthetic/example/pull/12'}),stderr:'',timedOut:false,notFound:false};};
 return {store,now,repo,head,ref,run,publication,hold,calls,exec};
}
test.each(['full','off',null] as const)('held Full gate precedes own-pass/off/legacy shortcuts (%s)',level=>{
 const w=world(level);expect(fullCheckGate(w.store,w.run,w.now).state).toBe('clear');const old=w.store.handle.prepare('SELECT * FROM run_check WHERE run=?').get(w.run);w.hold();
 expect(fullCheckGate(w.store,w.run,w.now)).toMatchObject({state:'recovery-held',priorExecution:'unverified'});expect(w.store.handle.prepare('SELECT * FROM run_check WHERE run=?').get(w.run)).toEqual(old);
});
test('held gate precedes missing-project/no-command shortcut and invalid evidence blocks',()=>{
 const w=world(null,false);expect(fullCheckGate(w.store,w.run,w.now).state).toBe('clear');w.hold(true);expect(fullCheckGate(w.store,w.run,w.now)).toMatchObject({state:'recovery-held',recovery:{kind:'invalid-evidence'}});
});
test.each([false,true])('own Full pass plus merge anyway=%s cannot bypass hold or create reservation',async anyway=>{
 const w=world();w.hold();const before=w.store.handle.prepare('SELECT * FROM publication').all();
 expect(await mergePullRequest(w.store,{runId:w.run,by:'synthetic',anyway,exec:w.exec,clock:()=>w.now})).toMatchObject({ok:false,reason:'recovery-held'});
 expect(w.calls).toEqual([]);expect(w.store.handle.prepare('SELECT * FROM merge_in_flight').all()).toEqual([]);expect(w.store.handle.prepare('SELECT * FROM publication').all()).toEqual(before);
 expect(pullRequestViewOf(w.store,w.run)).toMatchObject({canMerge:false,fullCheck:{state:'recovery-held'},label:'Checks held after recovery'});
});
test('cached preflight then hold during remote read re-proves before final reservation and issues no merge',async()=>{
 const w=world();let view=false;const exec:PublishExec=async(file,args,options)=>{if(!view){view=true;w.hold();}return w.exec(file,args,options);};
 expect(await mergePullRequest(w.store,{runId:w.run,by:'synthetic',anyway:true,exec,clock:()=>w.now})).toMatchObject({ok:false,reason:'recovery-held'});
 expect(w.calls.some(c=>c[2]==='merge')).toBe(false);expect(w.store.handle.prepare('SELECT * FROM merge_in_flight').all()).toEqual([]);
 expect(w.store.handle.prepare("SELECT count(*) AS n FROM action_ledger WHERE action='pull request merged'").get()?.['n']).toBe(0);
});
test('hold appended by final reservation callback is re-proved before merge_in_flight insert',async()=>{
 const w=world();expect(await mergePullRequest(w.store,{runId:w.run,by:'synthetic',exec:w.exec,clock:()=>w.now,proceed:()=>{w.hold();return true;}})).toMatchObject({ok:false,reason:'recovery-held'});
 expect(w.calls.some(c=>c[2]==='merge')).toBe(false);expect(w.store.handle.prepare('SELECT * FROM merge_in_flight').all()).toEqual([]);
});
test('held green result does not auto-merge or claim Ready; actual prior external merge history remains',async()=>{
 const w=world();w.hold();const publication=w.store.publicationForRun(w.run)!;
 const followed=await followPullRequests(w.store,[{publication,state:'passing',headOid:w.head,remoteState:null,mergeCommit:null,rollup:[]}],{evidenceRoot:join(dir!,'evidence'),exec:w.exec,clock:()=>w.now});
 expect(followed).toMatchObject({merged:0,ready:0});expect(w.calls).toEqual([]);
 w.store.handle.prepare("UPDATE pull_request_follow SET merge_commit=?,merged_by='GitHub',merged_at=? WHERE publication=?").run('d'.repeat(40),w.now.toISOString(),w.publication);w.store.recordPublicationRemoteState(w.publication,'MERGED',w.now);
 expect(pullRequestViewOf(w.store,w.run)).toMatchObject({state:'merged',mergeCommit:'d'.repeat(40),canMerge:false,fullCheck:{state:'recovery-held'}});
});
test('no event preserves ordinary merge and external observed outcome',async()=>{
 const w=world();expect(await mergePullRequest(w.store,{runId:w.run,by:'synthetic',exec:w.exec,clock:()=>w.now})).toMatchObject({ok:true,commit:'d'.repeat(40)});expect(w.calls.some(c=>c[2]==='merge')).toBe(true);
});

test('invalid task family is held before historical own-pass clearance',()=>{
 const w=world();w.hold();w.store.handle.prepare("UPDATE task_ref SET revision_of='missing-parent' WHERE id=?").run(w.ref);
 expect(fullCheckGate(w.store,w.run,w.now)).toMatchObject({state:'recovery-held',recovery:{kind:'invalid-evidence'}});
 expect(w.store.handle.prepare('SELECT status FROM run_check WHERE run=?').get(w.run)?.['status']).toBe('passed');
});
test('held merge refusal preserves a previous in-flight reservation rather than pretending cancellation',async()=>{
 const w=world();w.store.handle.prepare('INSERT INTO merge_in_flight(publication,task_ref,token,by,at) VALUES (?,?,?,?,?)').run(w.publication,w.ref,'prior-token','prior-worker',w.now.toISOString());
 const old=w.store.handle.prepare('SELECT * FROM merge_in_flight').all();w.hold();
 expect(await mergePullRequest(w.store,{runId:w.run,by:'synthetic',anyway:true,exec:w.exec,clock:()=>w.now})).toMatchObject({ok:false,reason:'recovery-held'});
 expect(w.calls).toEqual([]);expect(w.store.handle.prepare('SELECT * FROM merge_in_flight').all()).toEqual(old);
});
test('hold remains orthogonal to genuine historical failed check status',()=>{
 const w=world();w.store.recordRunCheck(w.run,{status:'failed',exitCode:1,suites:[]},w.now);const failed=w.store.handle.prepare('SELECT * FROM run_check WHERE run=?').get(w.run);w.hold();
 expect(fullCheckGate(w.store,w.run,w.now).state).toBe('recovery-held');expect(w.store.handle.prepare('SELECT * FROM run_check WHERE run=?').get(w.run)).toEqual(failed);
});
