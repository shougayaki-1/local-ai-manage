const spec=await import(new URL(import.meta.url.endsWith('.ts')?'../engine/care-record/lib/canonical-spec.mjs':'../../engine/care-record/lib/canonical-spec.mjs',import.meta.url).href) as typeof import('../engine/care-record/lib/canonical-spec.mjs');
export const {parseCanonicalPaths,parseCanonicalBinding,canonicalSpec}=spec;
export type {CanonicalBinding} from '../engine/care-record/lib/canonical-spec.mjs';
