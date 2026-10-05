import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertLocalSupabaseEnvironment } from './local-environment.mjs';
import { parseE2e } from '../lib/human-approval.mjs';

const repoRoot = resolve(process.argv[2]);
const sourceSupabaseDir = resolve(repoRoot, 'supabase');
const scope = parseE2e(JSON.parse(process.argv[3]));
const dbTests=process.argv[4]==='--db-tests';
if(process.argv.length>5||process.argv[4]!==undefined&&!dbTests)throw new Error('Invalid local verification mode');
let stopping=false;let activeChild;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;activeChild?.kill('SIGTERM');});
const playwrightArgs = ['test', ...scope.specs.map(spec => `tests/${spec}.spec.ts`),
  ...scope.projects.map(project => `--project=${project}`), '--retries=0', '--forbid-only', '--reporter=json'];

assertLocalSupabaseEnvironment(process.env, { requireApi: false });

async function run(binary,args,options={}) {
 if(stopping&&!options.cleanup)throw new Error('Local verification interrupted');
 return await new Promise((resolveRun,reject)=>{
  const child=spawn(binary,args,{cwd:options.cwd??(binary==='supabase'?workdir:repoRoot),env:options.env??process.env,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});child.stdin.end(options.input);
  activeChild=child;let output='';let bytes=0;let exceeded=false;
  const inspect=chunk=>{bytes+=chunk.length;if(bytes>20_000_000){exceeded=true;child.kill('SIGTERM');}};
  child.stdout.on('data',chunk=>{inspect(chunk);if(!exceeded)output+=chunk;});child.stderr.on('data',inspect);
  const timeout=setTimeout(()=>{exceeded=true;child.kill('SIGTERM');},options.cleanup?20000:900000);
  child.once('error',()=>{clearTimeout(timeout);reject(new Error('Local verification prerequisite unavailable'));});
  child.once('close',code=>{clearTimeout(timeout);if(activeChild===child)activeChild=null;if(code===0&&!exceeded&&(options.cleanup||!stopping))resolveRun(output);else {const error=new Error('Local verification failed; output omitted');error.assertions=[...output.matchAll(/(?:^|\n)\s*not ok\s+(\d+)/g)].map(match=>Number(match[1])).filter(number=>number>0&&number<=100000).slice(0,32);reject(error);}});
 });
}
function copyRegularTree(source,target){
 const info=lstatSync(source);if(info.isSymbolicLink())throw new Error('Unsafe verification input');
 if(info.isDirectory()){mkdirSync(target,{recursive:true});for(const name of readdirSync(source))copyRegularTree(resolve(source,name),resolve(target,name));}
 else if(info.isFile()&&info.size<=1048576)copyFileSync(source,target);
 else throw new Error('Unsafe verification input');
}

async function freePort(usedPorts) {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  if (!port || usedPorts.has(port)) return freePort(usedPorts);
  usedPorts.add(port);
  return port;
}

async function writeIsolatedConfig(workdir) {
  const usedPorts = new Set();
  const configPath = new URL('./supabase.config.toml.reference',import.meta.url);
  let config = readFileSync(configPath, 'utf8').replace(/(\[db\.seed\][\s\S]*?enabled\s*=\s*)true/, '$1false');
  const projectId = `care-record-e2e-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  config = config.replace(/^project_id\s*=\s*"[^"]+"/m, `project_id = "${projectId}"`);

  const portMatches = [...config.matchAll(/^(\s*(?:port|shadow_port|inspector_port)\s*=\s*)(\d+)(\s*(?:#.*)?)$/gm)];
  const ports = new Map();
  for (const [, , oldPort] of portMatches) {
    if (!ports.has(oldPort)) ports.set(oldPort, await freePort(usedPorts));
  }
  config = config.replace(/^(\s*(?:port|shadow_port|inspector_port)\s*=\s*)(\d+)(\s*(?:#.*)?)$/gm, (_line, prefix, oldPort, suffix) => `${prefix}${ports.get(oldPort)}${suffix}`);

  const supabaseDir = resolve(workdir, 'supabase');
  const migrationsDir = resolve(supabaseDir, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(resolve(supabaseDir, 'config.toml'), config);
  for (const entry of readdirSync(resolve(sourceSupabaseDir, 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.sql')) {
      copyRegularTree(resolve(sourceSupabaseDir,'migrations',entry.name),resolve(migrationsDir,entry.name));
    }
  }
  const templatesDir = resolve(sourceSupabaseDir, 'templates');
  if(existsSync(templatesDir))copyRegularTree(templatesDir,resolve(supabaseDir,'templates'));
  if(dbTests){const tests=resolve(sourceSupabaseDir,'tests');mkdirSync(resolve(supabaseDir,'tests'));for(const entry of readdirSync(tests,{withFileTypes:true}))if(entry.name.endsWith('.test.sql'))copyRegularTree(resolve(tests,entry.name),resolve(supabaseDir,'tests',entry.name));if(!readdirSync(resolve(supabaseDir,'tests')).length)throw new Error('No DB tests');}
  return projectId;
}

function parseSupabaseEnv(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

let workdir;
let projectId;
let exitCode = 1;
let stackStartAttempted = false;
let phase='prepare';
const progress=value=>{phase=value;process.stdout.write(JSON.stringify({event:'local-verification',phase})+'\n');};
let cleanupSucceeded=true;

try {
  workdir = mkdtempSync(resolve(tmpdir(), 'care-record-e2e-'));
  projectId = await writeIsolatedConfig(workdir);

  stackStartAttempted = true;
  progress('start');
  await run('supabase', ['start', '--workdir', workdir]);
  progress('migrations');
  await run('supabase', ['db', 'reset', '--local', '--no-seed', '--workdir', workdir]);

  const localConfig = parseSupabaseEnv(await run('supabase', ['status', '-o', 'env', '--workdir', workdir]));
  const supabaseEnv = {
    ...process.env,
    APP_ENV: 'test',
    CI: 'true',
    AI_IMPORT_ENABLED: 'false',
    EXTERNAL_INTEGRATIONS_ENABLED: 'false',
    E2E_TEST_ENV: 'true',
    NEXT_PUBLIC_SUPABASE_URL: localConfig.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: localConfig.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: localConfig.SERVICE_ROLE_KEY,
    SUPABASE_DB_URL: localConfig.DB_URL,
    SUPABASE_MAILPIT_URL: localConfig.MAILPIT_URL || localConfig.INBUCKET_URL,
  };
  assertLocalSupabaseEnvironment(supabaseEnv);
  if (!supabaseEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || !supabaseEnv.SUPABASE_SERVICE_ROLE_KEY || !supabaseEnv.SUPABASE_DB_URL) {
    throw new Error('Supabase CLI did not return the local API keys and database URL required for E2E tests.');
  }

  if(dbTests){
    progress('db-tests');
    const paths=readdirSync(resolve(workdir,'supabase/tests')).map(name=>resolve(workdir,'supabase/tests',name));
    for(const path of paths){try{await run('supabase',['test','db',path,'--workdir',workdir]);}catch(error){const name=path.split('/').at(-1);if(/^[a-z_]+\.test\.sql$/.test(name))process.stderr.write(`Local DB test failed: ${name}; assertions: ${(error.assertions??[]).join(',')}\n`);throw error;}}
    progress('isolation');
    const isolation=resolve(sourceSupabaseDir,'tests/isolation/specs');
    if(existsSync(isolation)){
      const tester=(await run('docker',['exec',`supabase_db_${projectId}`,'sh','-c','find /usr/lib/postgresql /usr/local -type f -name isolationtester -print -quit'])).trim();
      if(!/^\/(?:usr\/lib\/postgresql|usr\/local)\/[A-Za-z0-9_./-]*\/isolationtester$/.test(tester)||tester.includes('..'))throw new Error('Local isolation tester unavailable');
      for(const name of readdirSync(isolation).filter(name=>name.endsWith('.spec')).sort()){
        const spec=resolve(isolation,name);if(!lstatSync(spec).isFile()||lstatSync(spec).isSymbolicLink()||lstatSync(spec).size>1048576)throw new Error('Unsafe isolation input');
        const output=await run('docker',['exec','-i',`supabase_db_${projectId}`,tester,'dbname=postgres user=postgres'],{input:readFileSync(spec)});
        if(/ERROR:|FATAL:|syntax error|deadlock detected/i.test(output)||!/<waiting \.\.\.>|completed/.test(output))throw new Error('Local isolation test failed');
      }
    }
    progress('db-types');
    const generated=await run('supabase',['gen','types','typescript','--local','--schema','public','--workdir',workdir]);
    const expectedPath=resolve(repoRoot,'src/types/database.generated.ts');
    if(!lstatSync(expectedPath).isFile()||lstatSync(expectedPath).isSymbolicLink())throw new Error('Unsafe type input');
    const normalize=value=>value.replace(/\r\n/g,'\n').trim();
    if(normalize(generated)!==normalize(readFileSync(expectedPath,'utf8')))throw new Error('Generated DB types differ');
  }
  progress('e2e');
  const output=await run('npx',['--no-install','playwright',...playwrightArgs],{env:supabaseEnv});
  exitCode=0;
  if(exitCode===0){
    const report=JSON.parse(output);
    let count = 0;
    const inspect = suites => {
      for (const suite of suites) {
        for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
          count++;
          if (test.expectedStatus !== 'passed' || test.results?.length !== 1 || test.results[0].status !== 'passed') throw new Error('E2E contains a skipped, retried or failed test');
        }
        inspect(suite.suites ?? []);
      }
    };
    inspect(report.suites ?? []);
    if (!count) throw new Error('No E2E tests executed');
  }
} catch (error) {
  process.stderr.write(`Local verification failed at ${phase}; output omitted\n`);
  exitCode = 1;
} finally {
  if (stackStartAttempted && workdir && projectId) {
    try {
      progress('cleanup');
      await run('supabase', ['stop', '--no-backup', '--workdir', workdir],{cleanup:true});
    } catch (error) {
      cleanupSucceeded=false;
      process.stderr.write('Local E2E cleanup failed; output omitted\n');
      exitCode = exitCode === 0 ? 1 : exitCode;
    }
  }
  if (workdir && cleanupSucceeded) rmSync(workdir, { recursive: true, force: true });
}

process.exitCode = exitCode;
