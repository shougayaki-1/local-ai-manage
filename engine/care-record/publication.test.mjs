import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentDisabled, branchSuppressionOnly } from './lib/publication.mjs';
import { verificationTests } from './lib/verification.mjs';

const branch = 'codex/issue-50-a11y-input';
const before = { headers: [], git: { deploymentEnabled: { 'codex/other': false } } };
const after = { headers: [], git: { deploymentEnabled: { 'codex/other': false, [branch]: false } } };

test('only explicit global/current branch deployment suppression permits publication', () => {
  assert.ok(deploymentDisabled(after, branch));
  assert.ok(deploymentDisabled({ git: { deploymentEnabled: false } }, branch));
  for (const config of [before, {}, { git: { deploymentEnabled: true } }, { git: { deploymentEnabled: { [branch]: true } } }]) assert.ok(!deploymentDisabled(config, branch));
});

test('branch suppression never permits modifying another deployment/security setting', () => {
  assert.ok(branchSuppressionOnly(before, after, branch));
  for (const config of [{ ...after, headers: ['changed'] }, { ...after, crons: [] }, { ...after, git: { deploymentEnabled: { [branch]: false } } }, { ...after, git: { deploymentEnabled: { [branch]: true } } }]) assert.ok(!branchSuppressionOnly(before, config, branch));
});

test('record form changes select relevant unit/UI/build checks without E2E execution', () => {
  assert.deepEqual(verificationTests(['M\tsrc/components/record/RecordMetaForm.tsx', 'A\tsrc/components/record/RecordMetaForm.stories.tsx', 'M\ttests/record-ui.spec.ts'], { 'test:unit': 'vitest run --project unit', 'test:ui': 'vitest run --project storybook', build: 'next build --webpack' }), ['test:unit', 'test:ui', 'build']);
});

import { readSuppressedDeployment, PublicationSafetyError } from './lib/publication.mjs';
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './lib/process.mjs';
import { verify } from './continuous-worker.mjs';
const scripts={typecheck:'tsc --noEmit',lint:'eslint',test:'npm run test:unit && npm run test:ui','test:unit':'vitest run --project unit','test:ui':'vitest run --project storybook',build:'next build --webpack'};
async function fixture(t,configuration={}){const root=await realpath(await mkdtemp('/private/tmp/publication-guard-'));t.after(()=>rm(root,{recursive:true,force:true}));const clone=join(root,'clone');await mkdir(clone);const git=(args,cwd=clone)=>command('git',args,{cwd});await git(['init','-b','main']);await git(['config','user.name','Synthetic']);await git(['config','user.email','synthetic@example.invalid']);await git(['remote','add','origin','https://github.com/test/repo.git']);await writeFile(join(clone,'vercel.json'),JSON.stringify(configuration));await writeFile(join(clone,'package.json'),JSON.stringify({scripts}));await writeFile(join(clone,'example.txt'),'base\n');await git(['add','.']);await git(['commit','-m','base']);const base=await git(['rev-parse','HEAD']);await git(['update-ref','refs/remotes/origin/main',base]);const current={number:1,branch:'codex/issue-1-example',worktree:join(root,'worktree'),base,stage:'implement',session:'SAVED_SESSION',failures:0,quotaWaits:0,result:{reasons:[]}};await git(['worktree','add','-b',current.branch,current.worktree,base]);await writeFile(join(current.worktree,'example.txt'),'implementation\n');let checks=0;const execute=async(binary,args,options)=>{if(binary==='git'&&args[0]==='fetch')return '';if(binary==='npm'){checks++;return '';}return command(binary,args,options);};return {root,clone,current,git,execute,checks:()=>checks};}
test('deployment guard fails closed on missing, malformed, symlink and oversized configuration',async t=>{const f=await fixture(t);const path=join(f.current.worktree,'vercel.json');for(const body of ['{}','{','x'.repeat(65537)]){await writeFile(path,body);await assert.rejects(readSuppressedDeployment(f.current.worktree,f.current.branch),PublicationSafetyError);}await rm(path);await assert.rejects(readSuppressedDeployment(f.current.worktree,f.current.branch),PublicationSafetyError);await symlink(join(f.clone,'vercel.json'),path);await assert.rejects(readSuppressedDeployment(f.current.worktree,f.current.branch),PublicationSafetyError);});
test('unsuppressed publication stops before checks or commit and preserves session/retry',async t=>{const f=await fixture(t);await assert.rejects(verify(f.current,f.execute),PublicationSafetyError);assert.equal(f.checks(),0);assert.equal(await f.git(['rev-parse','HEAD'],f.current.worktree),f.current.base);assert.equal(f.current.session,'SAVED_SESSION');assert.equal(f.current.failures,0);});
test('only disabling this branch permits config change while retaining all other security settings',async t=>{const config={headers:[],git:{deploymentEnabled:{'codex/other':false}}};const f=await fixture(t,config);const path=join(f.current.worktree,'vercel.json');await writeFile(path,JSON.stringify({headers:['UNSAFE'],git:{deploymentEnabled:{'codex/other':false,[f.current.branch]:false}}}));await assert.rejects(verify(f.current,f.execute),/human verification/);assert.equal(f.checks(),0);await writeFile(path,JSON.stringify({headers:[],git:{deploymentEnabled:{'codex/other':false,[f.current.branch]:false}}}));await verify(f.current,f.execute);assert.equal(f.checks(),2);assert.equal(await f.git(['status','--porcelain'],f.current.worktree),'');});
test('a check cannot enable deployment under an unchanged git status before commit',async t=>{const f=await fixture(t,{git:{deploymentEnabled:{}}});const path=join(f.current.worktree,'vercel.json');await writeFile(path,JSON.stringify({git:{deploymentEnabled:{[f.current.branch]:false}}}));const execute=async(binary,args,options)=>{const output=await f.execute(binary,args,options);if(binary==='npm'&&args[1]==='lint')await writeFile(path,JSON.stringify({git:{deploymentEnabled:true}}));return output;};await assert.rejects(verify(f.current,execute),PublicationSafetyError);assert.equal(await f.git(['rev-parse','HEAD'],f.current.worktree),f.current.base);});

import { prepareSuppressedDeployment } from './lib/publication.mjs';
test('managed parent adds only current branch suppression before verification and preserves saved work',async t=>{
 const config={headers:[],git:{deploymentEnabled:{'codex/other':false}}};const f=await fixture(t,config);
 f.current.preflight={category:'deploy',reason:'branch_deployment_not_disabled'};
 await verify(f.current,f.execute,'care-record-v1',undefined,true);
 const saved=JSON.parse(await import('node:fs/promises').then(fs=>fs.readFile(join(f.current.worktree,'vercel.json'),'utf8')));
 assert.ok(branchSuppressionOnly(config,saved,f.current.branch));assert.equal(f.current.preflight,undefined);assert.equal(f.current.session,'SAVED_SESSION');assert.equal(f.current.failures,0);assert.equal(f.checks(),2);
});
test('automatic suppression refuses unrelated config edits, enabled global switch and links',async t=>{
 const config={headers:[],git:{deploymentEnabled:{}}};const f=await fixture(t,config);const path=join(f.current.worktree,'vercel.json');
 await writeFile(path,JSON.stringify({...config,headers:['changed']}));await assert.rejects(prepareSuppressedDeployment(f.current.worktree,f.current.branch,config),PublicationSafetyError);
 await writeFile(path,JSON.stringify({git:{deploymentEnabled:true}}));await assert.rejects(prepareSuppressedDeployment(f.current.worktree,f.current.branch,{git:{deploymentEnabled:true}}),PublicationSafetyError);
 await rm(path);await symlink(join(f.clone,'vercel.json'),path);await assert.rejects(prepareSuppressedDeployment(f.current.worktree,f.current.branch,config),PublicationSafetyError);
 assert.deepEqual(JSON.parse(await import('node:fs/promises').then(fs=>fs.readFile(join(f.clone,'vercel.json'),'utf8'))),config);
});
