import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {canonicalSpec,parseCanonicalPaths,parseCanonicalBinding} from './lib/canonical-spec.mjs';
const blob=content=>({sha:createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex'),size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64'),encoding:'base64'});
function fixture(content='Canonical decision',mode='100644'){
 const file=blob(content),root='a'.repeat(40),directory='b'.repeat(40),revision='c'.repeat(40);const reads=[];
 const read=async path=>{reads.push(path);if(path==='commits?per_page=1')return [{sha:revision,commit:{tree:{sha:root}}}];if(path===`git/trees/${root}`)return {sha:root,truncated:false,tree:[{path:'docs',sha:directory,type:'tree',mode:'040000'}]};if(path===`git/trees/${directory}`)return {sha:directory,truncated:false,tree:[{path:'system-decisions.md',sha:file.sha,type:'blob',mode}]};if(path===`git/blobs/${file.sha}`)return file;throw new Error('unknown fixed route');};return {file,read,reads};
}
test('canonical requirements bind tracked immutable blobs and expose content only to worker',async()=>{const f=fixture();const value=await canonicalSpec(['docs/system-decisions.md'],f.read);assert.equal(value.files[0].content,'Canonical decision');assert.equal(value.binding.digest.length,64);assert.deepEqual(parseCanonicalBinding(value.binding),value.binding);assert.ok(!JSON.stringify(value.binding).includes('Canonical decision'));});
test('canonical paths reject Issue-derived flags, traversal, credential locations and non-Markdown scope',()=>{for(const paths of [[],['../secret'],['/absolute/doc.md'],['docs/../secret.md'],['docs/.env.md'],['docs/spec.md?command=id'],['docs/spec.md','docs/spec.md'],['src/policy.ts']])assert.throws(()=>parseCanonicalPaths(paths));});
test('canonical observation fails closed for symlink, executable, truncated trees, oversized or forged bytes',async()=>{
 for(const mode of ['120000','100755']){const f=fixture('decision',mode);await assert.rejects(canonicalSpec(['docs/system-decisions.md'],f.read));}
 for(const mutation of [raw=>({...raw,size:65537}),raw=>({...raw,content:Buffer.from('forged').toString('base64')}),raw=>({...raw,encoding:'none'})]){const f=fixture();await assert.rejects(canonicalSpec(['docs/system-decisions.md'],async path=>path.includes('/blobs/')?mutation(await f.read(path)):f.read(path)));}
 const f=fixture();await assert.rejects(canonicalSpec(['docs/system-decisions.md'],async path=>path.includes('/trees/')?{...await f.read(path),truncated:true}:f.read(path)));
});
