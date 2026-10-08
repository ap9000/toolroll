#!/usr/bin/env node
/** Real providers and ordinary operator doors. No post-filing scope repair,
 * worktree patching, verdict override, or database edits rescue a journey. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Window} from 'happy-dom';
import {handoffFixture} from './fixtures/handoff-journey.mjs';
import {createFixtureLead,completeFixtureAssignment} from './canary-assertions.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let output=resolve('output/certification/handoff-journey.json'),playwright=null,providers=['claude','codex'],prepareOnly=false;
for(let i=2;i<process.argv.length;i++) {
  const arg=process.argv[i];
  if(arg==='--output') output=resolve(process.argv[++i]);
  else if(arg==='--playwright') playwright=resolve(process.argv[++i]);
  else if(arg==='--provider') providers=[process.argv[++i]];
  else if(arg==='--prepare-only') prepareOnly=true;
  else if(arg==='--help') { console.log('node scripts/handoff-journey.mjs --playwright /installed/playwright/index.mjs [--provider claude|codex] [--prepare-only] [--output file]');process.exit(0); }
  else throw new Error('Unknown argument '+arg);
}
assert(playwright&&providers.every(p=>['claude','codex'].includes(p)),'Choose the installed Playwright module and supported providers.');
const {openStore}=await import(join(root,'dist/store.js'));
const {createDecisionServer}=await import(join(root,'dist/serve.js'));
const {acceptanceToLines}=await import(join(root,'dist/scope.js'));
const models={claude:'opus',codex:'gpt-5.6-sol'};
async function run(file,args,cwd=root) {
  return new Promise((done,reject)=>{
    const child=spawn(file,args,{cwd,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    let forced=null;
    const signal=s=>{try{if(process.platform!=='win32')process.kill(-child.pid,s);else child.kill(s);}catch{}};
    const timer=setTimeout(()=>{signal('SIGTERM');forced=setTimeout(()=>signal('SIGKILL'),30_000);},25*60_000);
    child.on('error',error=>{clearTimeout(timer);if(forced)clearTimeout(forced);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(forced)clearTimeout(forced);done({code,stdout,stderr});});
  });
}
async function identity() {
  const hash=createHash('sha256');
  async function walk(dir,prefix) {for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {const p=join(dir,e.name),name=prefix+'/'+e.name;if(e.isDirectory())await walk(p,name);else hash.update(name).update('\0').update(await readFile(p)).update('\0');}}
  await walk(join(root,'dist'),'dist');const executableSha256=hash.copy().digest('hex');
  for(const file of ['scripts/handoff-journey.mjs','scripts/fixtures/handoff-journey.mjs','scripts/canary-assertions.mjs'])hash.update(file).update('\0').update(await readFile(join(root,file))).update('\0');
  return {sourceCommit:(await run('git',['rev-parse','HEAD'])).stdout.trim(),executableSha256,sha256:hash.digest('hex')};
}
const runtime=await identity(),startedAt=new Date().toISOString();
const retainedAt=await realpath(await mkdtemp(join(tmpdir(),'standing-orders-handoff-journey-')));
const results=[];
for(const provider of providers) {
  const model=models[provider],dir=join(retainedAt,provider),repo=join(dir,'repo'),db=join(dir,'orders.db'),pool=join(dir,'worktrees');
  const record={provider,model,passed:false,manualInterventions:0,retainedAt:dir,startedAt:new Date().toISOString(),steps:[]};
  const password='journey-'+randomUUID(),auth=['--as','journey','--token',password];
  let runnerToken=null,server=null,store=null,cookie='',base='';
  async function cli(label,args,accepted=[0]) {
    assert.deepEqual(await identity(),runtime,'Runtime changed during journey');
    const start=Date.now(),r=await run(process.execPath,[join(root,'dist/bin.js'),...args,'--db',db,'--json']);
    record.steps.push({label,durationMs:Date.now()-start,exitCode:r.code});
    assert(accepted.includes(r.code),label+': '+(r.stdout+'\n'+r.stderr).replaceAll(password,'[redacted]').replaceAll(runnerToken??'NO_TOKEN','[redacted]').slice(0,6000));
    return JSON.parse(r.stdout);
  }
  async function git(...args) {const r=await run('git',args,repo);assert.equal(r.code,0,r.stderr);return r.stdout.trim();}
  async function show(id,label=id) {const v=await cli('read '+label,['task','show',id]);await writeFile(join(dir,label+'.json'),JSON.stringify(v,null,2));return v;}
  async function form(page,action,overrides={}) {
    const r=await fetch(base+page,{headers:{cookie}});assert(r.ok,'GET '+page+' '+r.status);
    const window=new Window();window.document.write(await r.text());
    try {
      const f=[...window.document.querySelectorAll('form')].find(f=>f.getAttribute('action')===action);assert(f,'Form absent: '+action);
      const body=new URLSearchParams();
      for(const e of f.querySelectorAll('input[name],textarea[name],select[name]')) {if(['checkbox','radio'].includes(e.type)&&!e.checked)continue;body.set(e.name,e.value);}
      for(const [key,value] of Object.entries(overrides))body.set(key,value);
      const result=await fetch(base+action,{method:'POST',headers:{cookie,origin:base},body,redirect:'manual'});
      assert.equal(result.status,303,'POST '+action+' '+result.status+' '+(await result.text()).slice(-1200));
      record.steps.push({label:'ordinary form '+action,status:result.status});return result.headers.get('location');
    } finally {await window.happyDOM.abort();}
  }
  const tick=label=>cli(label,['tick','--runner','journey-worker','--token',runnerToken,'--repo',repo,'--pool',pool]);
  const scopeTerms=s=>({goal:s.goal,outOfScope:s.outOfScope,touches:[...s.touches].sort(),acceptance:s.acceptance.map(c=>({...c,evidence:[...c.evidence].sort()})).sort((a,b)=>a.id.localeCompare(b.id)),qualityMode:s.qualityMode,riskLevel:s.riskLevel});
  try {
    await mkdir(repo,{recursive:true});const fixture=handoffFixture(playwright);
    for(const [name,body] of Object.entries(fixture.files))await writeFile(join(repo,name),body);
    await git('init','-q','-b','main');await git('config','user.name','Handoff Journey');await git('config','user.email','journey@example.invalid');await git('add','.');await git('commit','-qm','seed fixed handoff journey');
    const baseSha=await git('rev-parse','HEAD');
    await cli('bootstrap isolated operator',['approver','add','journey','--password',password]);
    runnerToken=(await cli('repository-bound runner',['runner','register','journey-worker','--repo',repo,...auth])).token;
    for(const phase of ['plan','build','repair'])await cli('route '+phase,['config','set',phase,'--provider',provider,'--model',model,...auth]);
    await cli('approve fixture verification',['verify','set','--repo',repo,'--command','npm test','--timeout-seconds','120','--yes',...auth]);
    store=openStore(db);server=createDecisionServer({store,evidenceRoot:join(dir,'evidence'),repo});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
    const login=await fetch(base+'/login',{method:'POST',redirect:'manual',body:new URLSearchParams({name:'journey',token:password})});assert.equal(login.status,303);cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    await cli('file intentionally short title',['task','add','Ship catalog','--id','catalog','--repo',repo]);
    await cli('file detailed intent',['task','scope','catalog','--goal',fixture.goal,'--not',fixture.exclusions,'--touches',fixture.touches.join(','),'--acceptance',acceptanceToLines(fixture.acceptance).join(';')]);
    await form('/t/catalog','/t/catalog/scope',{'quality-mode':'strict'});
    const filed=await show('catalog','filed');assert.equal(filed.scope.qualityMode,'strict');
    if(prepareOnly) record.prepared=true;
    else {
    await cli('request planning',['task','plan','catalog',...auth]);
    console.log(provider+': planning the detailed filed intent');await tick('plan filed intent');
    const planned=await show('catalog','planned');assert.deepEqual(scopeTerms(planned.scope),scopeTerms(filed.scope),'Planner changed the fixed filed requirements');
    await cli('ordinary exact-scope approval',['task','approve','catalog','--yes','--digest',planned.scope.digest,...auth]);
    console.log(provider+': building and checking');await tick('approved build');
    const built=await show('catalog','built');assert.equal(built.task.state,'done');
    const build=built.runs.find(r=>r.role==='builder'&&r.outcome==='built');assert(build);
    const sourceHead=await git('rev-parse',build.branch),sourceHelper=await git('rev-parse',sourceHead+':filter.js');
    const leadFile=await createFixtureLead(args=>cli('scope fixture lead',args),{repo,auth,tokenFile:join(dir,'lead.token')});
    record.initialCompletion=await completeFixtureAssignment(args=>cli('inspect and handle source',args),'catalog',leadFile,{head:sourceHead,runId:build.id});
    await form('/r/'+build.id,'/r/'+build.id+'/comment',{path:'index.html',note:'Change only the visible heading from Catalog to Fruit catalog. Keep filter.js and all filtering behavior unchanged. Refresh desktop and mobile screenshot evidence by running npm test.'});
    const location=await form('/r/'+build.id,'/r/'+build.id+'/revise');
    assert(location?.startsWith('/t/'));const child=decodeURIComponent(location.split('/t/')[1].split(/[?#]/)[0]);record.revisionTask=child;
    const revision=await show(child,'revision-filed');
    for(const key of ['outOfScope','touches','acceptance','qualityMode','budgetMicrousd'])assert.deepEqual(revision.scope[key],filed.scope[key],'Revision dropped '+key);
    assert.equal(revision.scope.approvedAt,null,'Child inherited approval');
    await cli('approve exact revision',['task','approve',child,'--yes','--digest',revision.scope.digest,...auth]);
    console.log(provider+': building scoped revision and checking inherited code');await tick('scoped revision build');
    const final=await show(child,'revision-built');record.final=final;assert.equal(final.task.state,'done');
    const revisionBuild=final.runs.find(r=>r.role==='builder'&&r.outcome==='built');assert(revisionBuild);
    const head=await git('rev-parse',revisionBuild.branch);
    assert.equal(await git('rev-parse',head+':filter.js'),sourceHelper,'Inherited code changed');
    assert.deepEqual((await git('diff','--name-only',sourceHead,head)).split('\n'),['index.html'],'Revision exceeded requested scope');
    assert.match(await git('show',head+':index.html'),/Fruit catalog/);
    assert.equal(await git('rev-parse','main'),baseSha,'Default branch changed');
    assert(final.runs.every(r=>r.outcome!==null),'Orphan run');
    record.revisionCompletion=await completeFixtureAssignment(args=>cli('inspect and handle revision',args),child,leadFile,{head,runId:revisionBuild.id});
    const duplicate=await cli('duplicate dispatch',['tick','--runner','journey-worker','--token',runnerToken,'--repo',repo,'--pool',pool],[3]);assert.equal(duplicate.reason,'empty');
    record.passed=true;record.sourceHead=sourceHead;record.revisionHead=head;record.duplicateDispatch='refused-empty';
    }
  } catch(error) {record.error=String(error.stack??error).replaceAll(password,'[redacted]').replaceAll(runnerToken??'NO_TOKEN','[redacted]');}
  finally {if(server)await new Promise(r=>server.close(r));store?.close();}
  record.finishedAt=new Date().toISOString();results.push(record);await writeFile(join(dir,'result.json'),JSON.stringify(record,null,2));
  console.log(provider+': '+(record.prepared?'PREPARED (no provider invoked)':record.passed?'PASS':'FAIL '+record.error.split('\n')[0]));
}
const report={version:1,prepared:prepareOnly&&results.every(r=>r.prepared),passed:!prepareOnly&&results.every(r=>r.passed),runtime,runtimeUnchanged:JSON.stringify(await identity())===JSON.stringify(runtime),startedAt,finishedAt:new Date().toISOString(),retainedAt,manualInterventions:0,results,scope:prepareOnly?'Preparation only: private fixture, routes, verification approval, detailed strict/high-risk filing and ordinary form submission; no provider invoked.':'Detailed filed intent through planning, ordinary approval, real UI build, explicit lead completion, annotated revision and inherited-code checks under strict/high-risk terms. Fresh disposable repositories; no rescue edits.',exclusions:['Windows reboot','actual account exhaustion','production publication']};
report.passed&&=report.runtimeUnchanged;await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log('Handoff journey: '+output);if(!(prepareOnly?report.prepared:report.passed))process.exitCode=1;
