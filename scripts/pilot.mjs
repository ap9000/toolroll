#!/usr/bin/env node
/** Twenty real subscription tasks under preapproved fixture contracts, with explicit lead completion. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {scenario,scenarioIds} from './fixtures/pilot-scenarios.mjs';
import {createFixtureLead,completeFixtureAssignment} from './canary-assertions.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let output=resolve('output/certification/pilot.json'), concurrency=4, playwright=null, selected=scenarioIds, providers=['claude','codex'];
for(let i=2;i<process.argv.length;i++) {
  const arg=process.argv[i];
  if(arg==='--output') output=resolve(process.argv[++i]);
  else if(arg==='--concurrency') concurrency=Number(process.argv[++i]);
  else if(arg==='--playwright') playwright=resolve(process.argv[++i]);
  else if(arg==='--scenario') selected=[process.argv[++i]];
  else if(arg==='--provider') providers=[process.argv[++i]];
  else if(arg==='--help') {console.log('node scripts/pilot.mjs [--scenario id] [--provider claude|codex] [--concurrency 4] --playwright /installed/playwright/index.mjs [--output file]');process.exit(0);}
  else throw new Error('unknown argument '+arg);
}
assert(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4);
assert(selected.every(x=>scenarioIds.includes(x))&&providers.every(x=>['claude','codex'].includes(x)));
const models={claude:'sonnet',codex:'gpt-5.6-sol'};
function run(file,args,options={}) {
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(file,args,{cwd:options.cwd??root,env:process.env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr=''; child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c);
    const timer=setTimeout(()=>child.kill('SIGTERM'),options.timeoutMs??20*60_000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',(code,signal)=>{clearTimeout(timer);resolvePromise({code,signal,stdout,stderr});});
  });
}
async function identity() {
  const hash=createHash('sha256');
  async function visit(dir,prefix) {for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {const p=join(dir,e.name),name=prefix+'/'+e.name;if(e.isDirectory()) await visit(p,name);else hash.update(name).update('\0').update(await readFile(p)).update('\0');}}
  await visit(join(root,'dist'),'dist'); const executableSha256=hash.copy().digest('hex');
  for(const file of ['package.json','scripts/pilot.mjs','scripts/fixtures/pilot-scenarios.mjs','scripts/canary-assertions.mjs']) hash.update(file).update('\0').update(await readFile(join(root,file))).update('\0');
  return {sha256:hash.digest('hex'),executableSha256,sourceCommit:(await run('git',['rev-parse','HEAD'])).stdout.trim()};
}
const runtime=await identity(), startedAt=new Date();
const base=await realpath(await mkdtemp(join(tmpdir(),'standing-orders-real-pilot-')));
const results=[];
async function one(id,provider,wave) {
  const spec=scenario(id,playwright), model=models[provider], name=provider+'-'+id;
  const dir=join(base,name), repo=join(dir,'repo'), db=join(dir,'orders.db'), pool=join(dir,'worktrees');
  const steps=[]; let final=null,baseSha=null;
  const record={name,scenario:id,category:spec.category,provider,model,wave,passed:false,manualInterventions:0,retainedAt:dir,startedAt:new Date().toISOString(),steps};
  async function cli(label,args,accepted=[0]) {
    assert.deepEqual(await identity(),runtime,'runtime changed during the pilot');
    const start=Date.now(), result=await run(process.execPath,[join(root,'dist/bin.js'),...args,'--db',db,'--json']);
    steps.push({label,durationMs:Date.now()-start,exitCode:result.code});
    if(!accepted.includes(result.code)) throw new Error(label+': '+(result.stdout+'\n'+result.stderr).slice(0,6000));
    return JSON.parse(result.stdout);
  }
  const git=async args=>{const r=await run('git',args,{cwd:repo}); assert.equal(r.code,0,r.stderr);return r.stdout.trim();};
  try {
    await mkdir(repo,{recursive:true});
    for(const [name,body] of Object.entries(spec.files)) {const path=join(repo,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,body);}
    if(spec.dependency) {const lock=await run('npm',['install','--package-lock-only','--ignore-scripts','--offline'],{cwd:repo});assert.equal(lock.code,0,lock.stderr);}
    await git(['init','-q','-b','main']);await git(['config','user.email','pilot@example.invalid']);await git(['config','user.name','Unattended Pilot']);await git(['add','.']);await git(['commit','-qm','seed fixed pilot assignment']);baseSha=await git(['rev-parse','HEAD']);
    const password='pilot-'+randomUUID(),auth=['--as','pilot','--token',password];
    await cli('isolated fixture approver',['approver','add','pilot','--password',password]);
    const registered=await cli('repository-bound worker',['runner','register','worker','--repo',repo,...auth]);
    for(const phase of ['plan','build','repair']) await cli('route '+phase,['config','set',phase,'--provider',provider,'--model',model,...auth]);
    await cli('bounded standing mode',['mode','set','--repo',repo,'--name','standard','--days','1',...auth]);
    if(spec.dependency) await cli('approved offline setup',['setup','set','--repo',repo,'--command','npm ci --offline --ignore-scripts','--timeout-seconds','120','--yes',...auth]);
    await cli('approved verification',['verify','set','--repo',repo,'--command','npm test','--timeout-seconds','120','--yes',...auth]);
    const title='Pilot '+id+': implement the approved scope in '+spec.paths.join(', ')+'. Run npm test before writing proof. Do not modify verification, package, or vendor files.';
    await cli('file assignment',['task','add',title,'--id','work','--repo',repo]);
    const rubric=[
      'The requested behavior passes every assertion in the provided verify.mjs.|check',
      'The implementation changes only '+spec.paths.join(' and ')+'.|changed-path',
      ...(spec.ui?['Desktop and mobile screenshots show the requested interface after the tested interaction at 1280x800 and 390x844.|screenshot,check']:[]),
    ].join(';');
    await cli('file fixed scope',['task','scope','work','--goal',spec.goal,'--touches',spec.paths.join(','),'--acceptance',rubric,'--not','Changing tests or dependency definitions, external publication, or unrelated files.']);
    const preview=await cli('read scope',['task','show','work']);
    await cli('approve exact fixture scope',['task','approve','work','--yes','--digest',preview.scope.digest,'--terms',preview.approvalTerms,...auth]);
    await writeFile(join(dir,'runner-token'),registered.token,{mode:0o600});
    console.log(name+': starting unattended build and check');
    const start=Date.now();
    const worker=await run(process.execPath,[join(root,'dist/bin.js'),'watch','--runner','worker','--token-file',join(dir,'runner-token'),'--repo',repo,'--pool',pool,'--for','1000','--tick-every','200','--reconcile-every','1000','--bridge-every','3600000','--db',db,'--json']);
    await writeFile(join(dir,'watch-result.json'),JSON.stringify(worker,null,2));
    steps.push({label:'unattended watch build and check',durationMs:Date.now()-start,exitCode:worker.code});
    final=await cli('read final result',['task','show','work']);
    record.final=final;
    assert.equal(worker.code,0,'watch failed');
    assert.equal(final.task.state,'done','task did not complete');
    const build=final.runs.find(r=>r.role==='builder'&&r.outcome==='built'); assert(build,'missing completed build');
    assert(final.runs.every(r=>r.outcome!==null),'open orphan run');
    const head=await git(['rev-parse',build.branch]); assert.notEqual(head,baseSha);
    const changed=(await git(['diff','--name-only',baseSha,head])).split('\n').filter(Boolean).sort();
    assert.deepEqual(changed,[...spec.paths].sort(),'unexpected or missing changed paths');
    assert.equal(await git(['rev-parse','main']),baseSha,'default branch changed');
    const leadFile=await createFixtureLead(args=>cli('scope fixture lead',args),{repo,auth,tokenFile:join(dir,'lead.token')});
    record.completion=await completeFixtureAssignment(args=>cli('inspect and handle result',args),'work',leadFile,{head,runId:build.id});
    const duplicate=await cli('duplicate dispatch',['tick','--runner','worker','--token',registered.token,'--repo',repo,'--pool',pool],[3]);assert.equal(duplicate.reason,'empty');
    assert.deepEqual(await identity(),runtime);
    record.commit=head;record.changed=changed;record.duplicateDispatch='refused-empty';record.passed=true;
  } catch(error) {
    record.error=error.stack;
    if(final===null) {try{record.final=await cli('failure state',['task','show','work']);}catch{}}
  }
  record.finishedAt=new Date().toISOString();record.durationSeconds=(Date.parse(record.finishedAt)-Date.parse(record.startedAt))/1000;
  results.push(record);await writeFile(join(dir,'result.json'),JSON.stringify(record,null,2));
  console.log(name+': '+(record.passed?'PASS':'FAIL '+record.error.split('\n')[0]));
}
// Two successive service batches, each with fresh provider sessions and repositories.
for(let wave=1;wave<=2;wave++) {
  const ids=selected.filter((_,i)=>selected.length===1?wave===1:(i<5?wave===1:wave===2));
  const queue=ids.flatMap(id=>providers.map(provider=>({id,provider})));
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},async()=>{while(queue.length){const job=queue.shift();await one(job.id,job.provider,wave);}}));
}
const times=results.map(r=>r.durationSeconds).sort((a,b)=>a-b), percentile=p=>times[Math.ceil(times.length*p)-1]??null;
const report={version:1,passed:results.every(r=>r.passed),runtime,runtimeUnchanged:JSON.stringify(await identity())===JSON.stringify(runtime),startedAt:startedAt.toISOString(),finishedAt:new Date().toISOString(),platform:process.platform,node:process.versions.node,retainedAt:base,total:results.length,completed:results.filter(r=>r.passed).length,p50Seconds:percentile(.5),p95Seconds:percentile(.95),manualInterventions:0,results,
 scope:'Real subscription builds, approved checks, and explicit lead completion in disposable repositories across two sequential batches. Contracts are fixed and approved before unattended dispatch. Failed cases receive no manual rescue.',
 exclusions:['provider-authored planning (separately exercised by certify:provider)','mid-flight human revision or approval','direct-provider latency comparison','Windows','actual subscription exhaustion','production publication']};
report.passed&&=report.runtimeUnchanged;
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log('Pilot: '+output+' ('+report.completed+'/'+report.total+')');if(!report.passed)process.exitCode=1;
