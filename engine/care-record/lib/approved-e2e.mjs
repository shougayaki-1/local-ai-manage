import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, parseE2e, HumanApprovalError } from './human-approval.mjs';

// Reviewed local runner/config only. No commands, args or environment from Issue
// prose or an approval are evaluated. Changes to these policies need a new profile.
const pinned = {
  'playwright.config.ts': '0cfed6fa2a38ed34dc427f470ce8d5efb0782995ed31826ac871c3220e30fb64',
  'scripts/e2e/local-environment.mjs': 'a44b17e1cd2ec92ef6b68f1b1a449d1833e03e4feb6d9ad179c8d682a52a66cd',
};
export async function assertE2ePlan(root, scripts, profile, scope) {
  parseE2e(scope);
  for(const name of ['.env','.env.local','.env.development','.env.development.local']){try{await lstat(join(root,name));throw new HumanApprovalError(['credential']);}catch(error){if(error.code!=='ENOENT')throw error;}}
  if (profile !== 'care-record-v1' || scripts?.dev !== 'next dev --webpack' || scripts.predev || scripts.postdev) throw new HumanApprovalError(['manual_e2e']);
  for (const [name, hash] of Object.entries(pinned)) {
    const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw new HumanApprovalError(['manual_e2e']);
      const buffer = Buffer.alloc(65537); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536 || digest(buffer.subarray(0, bytesRead)) !== hash) throw new HumanApprovalError(['manual_e2e']);
    } finally { await file.close(); }
  }
}
export async function runApprovedE2e(current, scripts, profile, scope, execute) {
  await assertE2ePlan(current.worktree, scripts, profile, scope);
  await execute('node', [fileURLToPath(new URL('../e2e/run-local.mjs', import.meta.url)), current.worktree, JSON.stringify(parseE2e(scope))],
    { cwd: current.worktree, timeout: 600_000, testMode: true });
}

export async function runAutomaticLocal(current,scripts,profile,scope,execute){
 await assertE2ePlan(current.worktree,scripts,profile,scope);
 await execute('node',[fileURLToPath(new URL('../e2e/run-local.mjs',import.meta.url)),current.worktree,JSON.stringify(parseE2e(scope)),'--db-tests'],{cwd:current.worktree,timeout:600_000,testMode:true});
}
