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

// Managed publication may prepare precisely one branch's opt-out, never enable
// deployments or rewrite security settings. Only an unchanged saved-base config
// can be amended; an agent-edited config still requires human reconciliation.
export async function prepareSuppressedDeployment(root,branch,before) {
 if(!/^codex\/[A-Za-z0-9._/-]+$/.test(branch)||branch.includes('..'))throw new PublicationSafetyError();
 let file;
 try {
  file=await open(join(root,'vercel.json'),constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=await file.stat();if(!info.isFile()||info.nlink!==1||info.size>65536)throw new PublicationSafetyError();
  const buffer=Buffer.alloc(65537);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>65536)throw new PublicationSafetyError();
  const config=JSON.parse(buffer.subarray(0,bytesRead).toString());
  if(deploymentDisabled(config,branch))return config;
  if(JSON.stringify(config)!==JSON.stringify(before)||!config||typeof config!=='object'||Array.isArray(config))throw new PublicationSafetyError();
  const after=structuredClone(config);after.git??={};after.git.deploymentEnabled??={};
  if(!after.git.deploymentEnabled||typeof after.git.deploymentEnabled!=='object'||Array.isArray(after.git.deploymentEnabled))throw new PublicationSafetyError();
  after.git.deploymentEnabled[branch]=false;
  if(!branchSuppressionOnly(before,after,branch)||!deploymentDisabled(after,branch))throw new PublicationSafetyError();
  const bytes=Buffer.from(JSON.stringify(after,null,2)+'\n');if(bytes.length>65536)throw new PublicationSafetyError();
  await file.write(bytes,0,bytes.length,0);await file.truncate(bytes.length);await file.sync();return after;
 }catch{throw new PublicationSafetyError();}finally{await file?.close();}
}
