import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const dashboardSessionLifetime=30*24*60*60*1000;
const renewalInterval=24*60*60*1000;

/** Private signing key survives controller restarts; browser tokens never go on disk. */
export async function dashboardAuth(directory?:string) {
 let key=randomBytes(32);
 if(directory){
  const root=resolve(directory);const entry=await lstat(root);
  if(!entry.isDirectory()||entry.isSymbolicLink()||entry.uid!==process.getuid?.()||(entry.mode&0o077)!==0||await realpath(root)!==root)throw new Error('unsafe_dashboard_auth_directory');
  const path=join(root,'dashboard-auth.key');
  try {
   const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await handle.writeFile(key);await handle.sync();}finally{await handle.close();}
   const parent=await open(root,constants.O_RDONLY);try{await parent.sync();}finally{await parent.close();}
  }catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='EEXIST')throw error;}
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
   const info=await handle.stat();
   if(!info.isFile()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||info.nlink!==1||info.size!==32)throw new Error('unsafe_dashboard_auth_key');
   key=await handle.readFile();
   if(key.length!==32)throw new Error('invalid_dashboard_auth_key');
  }finally{await handle.close();}
 }
 const sign=(value:string)=>createHmac('sha256',key).update(`local-ai-manage-dashboard:${value}`).digest('hex');
 const issue=(now:number,id=randomBytes(32).toString('hex'))=>{const value=`v1.${now}.${id}`;return `${value}.${sign(value)}`;};
 const verify=(token:string,now:number)=>{
  const match=/^v1\.(\d{1,16})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(token);if(!match)return null;
  const issuedAt=Number(match[1]);
  if(!Number.isSafeInteger(issuedAt)||issuedAt>now||now-issuedAt>=dashboardSessionLifetime)return null;
  const value=token.slice(0,token.lastIndexOf('.'));
  if(!timingSafeEqual(Buffer.from(sign(value),'hex'),Buffer.from(match[3]!,'hex')))return null;
  return {id:match[2]!,renew:now-issuedAt>=renewalInterval};
 };
 return {issue,verify,csrf:sign('csrf'),cookie:(token:string)=>`lam_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${dashboardSessionLifetime/1000}`};
}
