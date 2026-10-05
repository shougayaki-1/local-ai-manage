export type CanonicalBinding={kind:'canonical';digest:string;paths:string[]};
export function parseCanonicalPaths(value:unknown):string[];
export function parseCanonicalBinding(value:unknown):CanonicalBinding;
export function canonicalSpec(paths:string[],read:(resource:string)=>Promise<unknown>):Promise<{binding:CanonicalBinding;files:{path:string;sha:string;content:string}[]}>;
