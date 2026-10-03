import { lstat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
/** Both markers are permanent fail-closed gates until an explicitly completed rotation. */
export async function assertRecoveryClear(directory:string):Promise<void> {
 for(const path of [join(directory,'recovery.lock'),join(directory,'recovery-journal.json'),join(directory,'retired.json'),replacementGate(directory)]) {
  try {await lstat(path);}
  catch(error){if(error instanceof Error&&'code' in error&&error.code==='ENOENT')continue;throw error;}
  throw new Error('controller_recovery_required');
 }
}

export function replacementGate(directory:string):string {return join(dirname(directory),`.${basename(directory)}.recovery.lock`);}
