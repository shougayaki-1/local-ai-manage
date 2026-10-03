import { assertProfileId, assertManagerScripts } from './profiles.mjs';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { assertLocalCheck } from './lib/verification.mjs';
export async function assertProfile(root,profile='care-record-v1') {
  assertProfileId(profile);
  const file=await open(join(root,'package.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const info=await file.stat();if(!info.isFile() || info.size>65536)throw new Error('unsupported_profile');
    const buffer=Buffer.alloc(65537);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>65536)throw new Error('unsupported_profile');
    const value=JSON.parse(buffer.subarray(0,bytesRead).toString());
    if(profile==='local-ai-manage-v1'){if(value.name!=='local-ai-manage')throw new Error('unsupported_profile');assertManagerScripts(value.scripts);return;}
    if(value.name!=='care-record-app')throw new Error('unsupported_profile');
    for(const name of ['typecheck','lint','test','test:unit','test:ui','build'])assertLocalCheck(value.scripts,name);
  } finally {await file.close();}
}
