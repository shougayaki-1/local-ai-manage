import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
export function deploymentDisabled(config, branch) {
  const enabled = config?.git?.deploymentEnabled;
  return enabled === false || (enabled && typeof enabled === 'object' && !Array.isArray(enabled) && enabled[branch] === false);
}

// Permit only disabling the current branch, with every other setting unchanged.
export function branchSuppressionOnly(before, after, branch) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  const expected = structuredClone(before);
  expected.git ??= {};
  expected.git.deploymentEnabled ??= {};
  if (typeof expected.git.deploymentEnabled !== 'object' || Array.isArray(expected.git.deploymentEnabled)) return false;
  expected.git.deploymentEnabled[branch] = false;
  return JSON.stringify(expected) === JSON.stringify(after);
}

export class PublicationSafetyError extends Error {
  constructor() {
    super('Branch deployment must be disabled before automatic publication');
    this.reason = 'branch_deployment_not_disabled';
  }
}

export async function readSuppressedDeployment(root,branch) {
 let file;
 try { file=await open(join(root,'vercel.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await file.stat();if(!stat.isFile()||stat.size>65536)throw new PublicationSafetyError();const buffer=Buffer.alloc(65537);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>65536)throw new PublicationSafetyError();const value=JSON.parse(buffer.subarray(0,bytesRead).toString());if(!deploymentDisabled(value,branch))throw new PublicationSafetyError();return value; }
 catch { throw new PublicationSafetyError(); }
 finally { await file?.close(); }
}
