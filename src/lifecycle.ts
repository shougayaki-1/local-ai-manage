/** Stop admission before cancelling read-only observation. An in-flight scheduler
 * tick may be waiting for that observation, so cancellation must precede its drain. */
export function drainDispatch(scheduler:{close():Promise<void>}|undefined,observer:{close():void}|undefined):Promise<void>{
 const drained=scheduler?.close()??Promise.resolve();observer?.close();return drained;
}
