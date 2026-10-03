// Controller-owned fixed policies, never load commands/policies from a repository file.
export const profileIds=Object.freeze(['care-record-v1','local-ai-manage-v1']);
export const managerScripts=Object.freeze({typecheck:'tsc --noEmit',lint:'eslint . --max-warnings=0',test:'node --experimental-strip-types --test test/*.test.ts && npm run test:engine','test:engine':'node --test engine/care-record/*.test.mjs',build:'tsc -p tsconfig.server.json && vite build'});
export function assertProfileId(profile){if(!profileIds.includes(profile))throw new Error('unsupported_profile');}
export function assertManagerCheck(scripts,name){
 if(!scripts||!['typecheck','lint','test','build'].includes(name)||scripts[name]!==managerScripts[name]||scripts[`pre${name}`]||scripts[`post${name}`])throw new Error('Check script requires human verification');
 if(name==='test'&&(scripts['test:engine']!==managerScripts['test:engine']||scripts['pretest:engine']||scripts['posttest:engine']))throw new Error('Check script requires human verification');
}
export function assertManagerScripts(scripts){
 for(const name of ['preinstall','install','postinstall','prepublish','preprepare','prepare','postprepare'])if(scripts?.[name])throw new Error('unsupported_profile');
 for(const name of ['typecheck','lint','test','build'])assertManagerCheck(scripts,name);
}
export function managerProtected(changed){
 return changed.some(line=>/\s+(?:engine\/|integrations\/|src\/(?:cli|controller|scheduler|worker-adapter|registry|handoff|recovery(?:-guard)?|github-queue|preflight|readiness|remote-status|status-publisher|status-actions|producer-plan|server|snapshot|telemetry|profiles|types)\.ts$|(?:Managed-)?Launch\.command$|registry\.[^/]+\.json$|(?:eslint|vite)\.config\.|tsconfig(?:\.server)?\.json$|\.agents\/|\.codex\/|\.github\/)/.test(line));
}

export class ProfileBindingError extends Error {}
