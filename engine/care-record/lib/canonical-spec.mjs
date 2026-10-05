import {createHash} from 'node:crypto';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export function parseCanonicalPaths(value){
 if(!Array.isArray(value)||!value.length||value.length>8||new Set(value).size!==value.length||value.some(path=>typeof path!=='string'||path.length>160||!/^docs\/(?:[a-zA-Z0-9_-]+\/){0,4}[a-zA-Z0-9_-]+\.md$/.test(path)))throw new Error('canonical_spec_invalid');
 return [...value].sort();
}
export function parseCanonicalBinding(value){
 if(!object(value)||Object.keys(value).length!==3||value.kind!=='canonical'||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))throw new Error('canonical_spec_invalid');
 return {kind:'canonical',digest:value.digest,paths:parseCanonicalPaths(value.paths)};
}
/** Trusted registry paths only, immutable Git objects, no filesystem or Issue path input. */
export async function canonicalSpec(paths,read){
 paths=parseCanonicalPaths(paths);
 const commits=await read('commits?per_page=1');
 if(!Array.isArray(commits)||commits.length!==1||!object(commits[0])||!hash(commits[0].sha)||!object(commits[0].commit)||!object(commits[0].commit.tree)||!hash(commits[0].commit.tree.sha))throw new Error('canonical_spec_unavailable');
 const cache=new Map();const files=[];let total=0;
 const tree=async sha=>{
  if(cache.has(sha))return cache.get(sha);
  const raw=await read(`git/trees/${sha}`);
  if(!object(raw)||raw.sha!==sha||raw.truncated!==false||!Array.isArray(raw.tree)||raw.tree.length>4096||raw.tree.some(item=>!object(item)||typeof item.path!=='string'||!hash(item.sha)||!['blob','tree','commit'].includes(item.type)))throw new Error('canonical_spec_unavailable');
  if(new Set(raw.tree.map(item=>item.path)).size!==raw.tree.length)throw new Error('canonical_spec_unavailable');cache.set(sha,raw.tree);return raw.tree;
 };
 for(const path of paths){
  let sha=commits[0].commit.tree.sha;const names=path.split('/');
  for(let index=0;index<names.length;index++){
   const item=(await tree(sha)).find(item=>item.path===names[index]);
   if(!item||item.type!==(index===names.length-1?'blob':'tree')||item.mode!==(index===names.length-1?'100644':'040000'))throw new Error('canonical_spec_unavailable');sha=item.sha;
  }
  const raw=await read(`git/blobs/${sha}`);
  if(!object(raw)||raw.sha!==sha||raw.encoding!=='base64'||!Number.isSafeInteger(raw.size)||raw.size<1||raw.size>65536||typeof raw.content!=='string'||raw.content.length>90000||!/^[A-Za-z0-9+/=\r\n]+$/.test(raw.content))throw new Error('canonical_spec_unavailable');
  const bytes=Buffer.from(raw.content.replace(/[\r\n]/g,''),'base64');
  if(bytes.length!==raw.size||(total+=bytes.length)>262144||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==sha)throw new Error('canonical_spec_unavailable');
  const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(content.includes('\0'))throw new Error('canonical_spec_unavailable');files.push({path,sha,content});
 }
 const digest=createHash('sha256').update(JSON.stringify(files.map(({path,sha})=>[path,sha]))).digest('hex');
 return {binding:{kind:'canonical',digest,paths},files};
}
