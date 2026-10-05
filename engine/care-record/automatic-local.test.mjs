import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {command} from './lib/process.mjs';
import {parseDispatchDescriptor} from './dispatch-contract.mjs';
import {automaticReviewEligible} from './lib/human-approval.mjs';
import {implementationPrompt} from './lib/codex-runner.mjs';
const runner=fileURLToPath(new URL('./e2e/run-local.mjs',import.meta.url));
async function fixture(t,{failure='',report='passed',delay=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'auto-local-')));t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'repo'),bin=join(root,'bin'),log=join(root,'commands.jsonl');
 await mkdir(join(repo,'supabase/migrations'),{recursive:true});await mkdir(join(repo,'supabase/tests'));await mkdir(join(repo,'src/types'),{recursive:true});await mkdir(bin);
 await writeFile(join(repo,'supabase/migrations/20261004.sql'),'select 1;');await writeFile(join(repo,'supabase/tests/security_hardening.test.sql'),'select 1;');await writeFile(join(repo,'src/types/database.generated.ts'),'export type Database = {};\n');
 const mock=`#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({binary:require('path').basename(process.argv[1]),args,hasRealToken:!!process.env.GH_TOKEN})+'\\n');const fail=${JSON.stringify(failure)};if(fail&&args.slice(0,2).join(' ')===fail)process.exit(1);if(args[0]==='status')console.log('API_URL="http://127.0.0.1:12345"\\nDB_URL="postgresql://postgres:test@127.0.0.1:12346/postgres"\\nANON_KEY="local"\\nSERVICE_ROLE_KEY="local"');if(args[0]==='gen')console.log('export type Database = {};');if(args[0]==='--no-install')console.log(JSON.stringify({suites:[{specs:[{tests:[{expectedStatus:'passed',results:[{status:${JSON.stringify(report)}}]}]}]}]}));${delay?"if(args[0]==='start')setTimeout(()=>{},180000);":''}`;
 for(const name of ['supabase','npx'])await writeFile(join(bin,name),mock,{mode:0o700});
 const run=options=>command(process.execPath,[runner,repo,JSON.stringify({specs:['auth'],projects:['chromium','mobile-chrome']}),'--db-tests'],{cwd:repo,testMode:true,parentEnv:{...process.env,PATH:bin+':'+process.env.PATH,GH_TOKEN:'must-not-inherit'},timeout:60000,...options});
 return {root,repo,log,run,calls:async()=>((await readFile(log,'utf8')).trim().split('\n').map(JSON.parse))};
}
test('automatic local runner applies migrations only in fresh project, runs DB/type/E2E checks and cleans own stack',async t=>{
 const f=await fixture(t);await f.run();const calls=await f.calls();assert.ok(calls.every(c=>!c.hasRealToken));
 const reset=calls.find(c=>c.args[0]==='db');assert.ok(reset.args.includes('--local')&&reset.args.includes('--no-seed'));const workdir=reset.args.at(-1);assert.notEqual(workdir,f.repo);
 assert.ok(calls.some(c=>c.args[0]==='test'&&c.args[1]==='db'));assert.ok(calls.some(c=>c.args[0]==='gen'&&c.args.includes('--local')));
 const browser=calls.find(c=>c.binary==='npx');assert.ok(browser.args.includes('--retries=0')&&browser.args.includes('--project=mobile-chrome'));assert.equal(calls.at(-1).args[0],'stop');assert.equal(calls.at(-1).args.at(-1),workdir);assert.ok(calls.every(c=>!c.args.includes('--linked')));
});
test('DB failure or skipped E2E never passes and still cleans the disposable stack',async t=>{
 for(const opts of [{failure:'test db'},{report:'skipped'}]){const f=await fixture(t,opts);await assert.rejects(f.run());assert.equal((await f.calls()).at(-1).args[0],'stop');}
});
test('interruption cleans disposable stack rather than leaving existing project reset risks',async t=>{
 const f=await fixture(t,{delay:true});const abort=new AbortController();const pending=f.run({signal:abort.signal});
 for(let i=0;i<100;i++){try{if((await f.calls()).some(c=>c.args[0]==='start'))break;}catch{}await new Promise(r=>setTimeout(r,20));}
 abort.abort();await assert.rejects(pending);assert.equal((await f.calls()).at(-1).args[0],'stop');
});
test('automatic policy is explicit trusted IPC data; code categories never include operational gates',()=>{
 const descriptor={version:1,profile:'care-record-v1',repo:'test/repo',clonePath:'/clone',stateDirectory:'/state',expectedIssue:1,reviewPolicy:'local-automatic'};assert.equal(parseDispatchDescriptor(descriptor).reviewPolicy,'local-automatic');assert.throws(()=>parseDispatchDescriptor({...descriptor,reviewPolicy:'bypass'}));
 for(const category of ['credential','production','destructive','deploy','external_service','specification','local_verification'])assert.equal(automaticReviewEligible([category]),false);
 const prompt=implementationPrompt({number:1},{worktree:'/clone',branch:'codex/issue-1'},'care-record-v1','local-automatic');assert.match(prompt,/authorizes the trusted parent/);assert.match(prompt,/Do not apply migrations or run E2E yourself/);
});

test('local DB failure reaches same-session repair as bounded phase/test identifiers without raw output',async()=>{
 const {failureSignals,CommandFailure,VerificationFailure,repairDiagnostic}=await import('./lib/failure.mjs');
 const signals=failureSignals('Local DB test failed: internal_work_idempotency.test.sql; assertions: 12\nLocal verification failed at db-tests; output omitted');
 const failure=new VerificationFailure('local_db_e2e',new CommandFailure(signals));assert.equal(failure.retryable,true);const diagnostic=repairDiagnostic(failure.diagnostic);assert.equal(diagnostic.phase,'db-tests');assert.equal(diagnostic.dbTest,'internal_work_idempotency');assert.equal(JSON.stringify(diagnostic).includes('assertions'),false);assert.equal(repairDiagnostic({...diagnostic,dbTest:'arbitrary-command'}),null);
});
