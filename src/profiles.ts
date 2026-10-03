export type WorkerProfile='care-record-v1'|'local-ai-manage-v1';
export function isWorkerProfile(value:unknown):value is WorkerProfile{return value==='care-record-v1'||value==='local-ai-manage-v1';}
export const reviewedProfiles=[
 {id:'care-record-v1',packageName:'care-record-app',model:'gpt-6.1-sol',effort:'medium',checks:['typecheck','lint','test:unit','test:ui','build'],scope:'CareRecord exact scripts and protected paths'},
 {id:'local-ai-manage-v1',packageName:'local-ai-manage',model:'gpt-6.1-sol',effort:'medium',checks:['typecheck','lint','test','build'],scope:'Local AI Manage UI and local tests; controller/engine/security changes require human review'},
] as const;
