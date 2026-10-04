import type { ReadinessReport } from './readiness.ts';
import { dashboardAuth } from './dashboard-auth.ts';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { ControlError, type Controller } from './controller.ts';
import type { Snapshot } from './types.ts';
import type { Approvals } from './approvals.ts';
import { record } from './registry.ts';
const equal=(a: string,b: string) => a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req: IncomingMessage): Promise<unknown> {
  let content='';
  for await (const chunk of req) { content+=chunk.toString(); if (Buffer.byteLength(content)>2048) throw new Error('body_limit'); }
  return JSON.parse(content);
}
export function privateIPv4(value:string):boolean {
  if(isIP(value)!==4)return false;
  const [a,b]=value.split('.').map(Number);
  return a===10 || a===192&&b===168 || a===172&&b!>=16&&b!<=31;
}
export function tailscaleIPv4(value:string):boolean {
  if(isIP(value)!==4)return false;
  const [a,b]=value.split('.').map(Number);
  return a===100&&b!>=64&&b!<=127;
}
export async function startServer({snapshot,webDirectory,port=0,now=Date.now,controller,approvals,readiness,lanAddress,tailscaleAddress}:{snapshot:()=>Promise<Snapshot>;webDirectory:string;port?:number;now?:()=>number;controller?:Controller;approvals?:Approvals;readiness?:()=>Promise<ReadinessReport>;lanAddress?:string;tailscaleAddress?:string}) {
  if(lanAddress&&tailscaleAddress)throw new Error('choose_one_network');
  const automatic=tailscaleAddress==='auto';
  const findAddress=()=>Object.values(networkInterfaces()).flat().find(entry=>entry?.family==='IPv4'&&!entry.internal&&tailscaleIPv4(entry.address))?.address;
  let mobileAddress=automatic?findAddress():tailscaleAddress??lanAddress;
  const allowedPeer=tailscaleAddress?tailscaleIPv4:privateIPv4;
  if(mobileAddress && (!allowedPeer(mobileAddress)||!Object.values(networkInterfaces()).flat().some(entry=>entry?.family==='IPv4'&&entry.address===mobileAddress&&!entry.internal)))throw new Error('invalid_mobile_address');
  const web=await realpath(webDirectory);
  if (!(await stat(join(web,'index.html'))).isFile()) throw new Error('build_required');
  const auth=await dashboardAuth(controller?.directoryPath());
  let nonce=randomBytes(32).toString('hex');
  const csrf=auth.csrf; let writeWindow=now();let writeCount=0;
  let started=now(); let redeemed=false; let attempts=0; let inFlight: Promise<Snapshot>|null=null;
  let origin=''; let host=''; let mobileHost=''; let mobileOrigin:string|undefined; let readWindow=now(); let readCount=0;
  const issueLaunchUrl=(mobile=false)=>{
    if(mobile&&(!mobileOrigin||automatic&&findAddress()!==mobileAddress))throw new Error('mobile_not_enabled');
    nonce=randomBytes(32).toString('hex');started=now();redeemed=false;attempts=0;
    return `${mobile?mobileOrigin:origin}/#${nonce}`;
  };
  const server=createServer({headersTimeout:5000,requestTimeout:10000,maxHeaderSize:8192}, async(req,res)=>{
    const send=(code:number,value:unknown)=>{ res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const local=req.socket.localAddress==='127.0.0.1';
      const expectedHost=local?host:mobileHost;
      const origin=`http://${expectedHost}`;
      if ((local?req.socket.remoteAddress!=='127.0.0.1':!mobileAddress||req.socket.localAddress!==mobileAddress||!allowedPeer(req.socket.remoteAddress??'')) || req.headers.host!==expectedHost || (req.headers.origin!==undefined && req.headers.origin!==origin) || req.headers['sec-fetch-site']==='cross-site' || !req.url?.startsWith('/') || req.url.startsWith('//')) return send(403,{error:'request_rejected'});
      const url=new URL(req.url,origin);
      if (url.search) return send(400,{error:'query_not_supported'});
      if (url.pathname==='/api/session' && req.method==='POST') {
        if (req.headers.origin!==origin || req.headers['content-type']!=='application/json' || req.headers['x-local-bootstrap']!=='1') return send(403,{error:'request_rejected'});
        if (++attempts>20) return send(429,{error:'rate_limited'});
        if (redeemed || now()-started>120_000) return send(403,{error:'bootstrap_expired'});
        const value=await body(req);
        if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || !('nonce' in value) || typeof value.nonce!=='string' || !equal(value.nonce,nonce)) return send(403,{error:'request_rejected'});
        // Recheck after asynchronous body read to make redemption single-use under concurrency.
        if (redeemed || now()-started>120_000) return send(403,{error:'bootstrap_expired'});
        redeemed=true; res.setHeader('Set-Cookie',auth.cookie(auth.issue(now())));
        return send(200,{authenticated:true,csrf});
      }
      if(url.pathname.startsWith('/api/')){
        const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lam_session='))?.slice(12)??'';
        const session=auth.verify(cookie,now());
        if(!session)return send(401,{error:'authentication_required'});
        if(session.renew)res.setHeader('Set-Cookie',auth.cookie(auth.issue(now(),session.id)));
      }
      if (controller && (url.pathname==='/api/controls' || url.pathname==='/api/approvals' || url.pathname==='/api/csrf' || url.pathname.startsWith('/api/requests/'))) {
        if (req.method==='GET') {
          if(now()-readWindow>=60_000){readWindow=now();readCount=0;}
          if(++readCount>120)return send(429,{error:'rate_limited'});
        }
        if (url.pathname==='/api/csrf' && req.method==='GET') return send(200,{csrf});
        const ack=url.pathname.match(/^\/api\/requests\/([0-9a-f-]{36})$/);
        if (ack && req.method==='GET') {const value=controller.ack(ack[1]!)??approvals?.ack(ack[1]!);return value?send(200,value):send(404,{error:'not_found'});}
        if (!['/api/controls','/api/approvals'].includes(url.pathname) || req.method!=='POST') return send(405,{error:'method_not_allowed'});
        if (req.headers.origin!==origin || req.headers['content-type']!=='application/json' || typeof req.headers['x-local-csrf']!=='string' || !equal(req.headers['x-local-csrf'],csrf)) return send(403,{error:'request_rejected'});
        if (now()-writeWindow>=60_000) {writeWindow=now();writeCount=0;}
        if (++writeCount>30) return send(429,{error:'rate_limited'});
        try {const command=await body(req);if(url.pathname==='/api/approvals'){if(!approvals)return send(503,{error:'approval_unavailable'});return send(200,await approvals.apply(command));}if(record(command)&&typeof command.requestId==='string'&&approvals?.ack(command.requestId))throw new ControlError('request_id_conflict',409);return send(200,await controller.apply(command));}
        catch(error) {if(error instanceof ControlError)return send(error.status,{error:error.message});return send(503,{error:'control_unavailable'});}
      }
      if (req.method!=='GET') return send(405,{error:'method_not_allowed'});
      if (url.pathname.startsWith('/api/')) {
        if (now()-readWindow>=60_000) { readWindow=now(); readCount=0; }
        if (++readCount>120) return send(429,{error:'rate_limited'});
        if(url.pathname==='/api/mobile-link'){
          if(!local)return send(403,{error:'local_link_required'});
          if(!mobileOrigin)return send(503,{error:'mobile_not_enabled'});
          return send(200,{url:issueLaunchUrl(true),expiresInSeconds:120});
        }
        if(url.pathname==='/api/readiness'){if(!readiness)return send(404,{error:'not_found'});return send(200,await readiness());}
        const allowed=['/api/status','/api/repositories','/api/queue','/api/runs','/api/logs'];
        const detail=url.pathname.match(/^\/api\/repositories\/([a-z0-9_.-]+--[a-z0-9_.-]+)\/status$/);
        if (!allowed.includes(url.pathname) && !detail) return send(404,{error:'not_found'});
        inFlight ??= snapshot().finally(()=>{ inFlight=null; });
        const data=await inFlight;
        if (detail) { const item=data.repositories.find(r=>r.id===detail[1]); return item ? send(200,item) : send(404,{error:'not_found'}); }
        if (url.pathname==='/api/repositories') return send(200,data.repositories);
        if (url.pathname==='/api/queue') return send(200,data.queue);
        if (url.pathname==='/api/logs') return send(200,data.repositories.map(r=>({repositoryId:r.id,...r.logs})));
        if (url.pathname==='/api/runs') return send(200,data.repositories.flatMap(r=>r.runs.map(run=>({repositoryId:r.id,...run}))));
        return send(200,data);
      }
      const path=url.pathname==='/' ? 'index.html' : url.pathname.slice(1);
      if (path!=='index.html' && !/^assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(path)) return send(404,{error:'not_found'});
      const file=await realpath(join(web,path)); if (!file.startsWith(`${web}${sep}`)) return send(404,{error:'not_found'});
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(file)];
      res.writeHead(200,{'Content-Type':mime??'application/octet-stream'}); res.end(await readFile(file));
    } catch { if (!res.headersSent) send(400,{error:'request_unavailable'}); else res.end(); }
  });
  server.maxConnections=32;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port},()=>{server.off('error',reject);resolve();});});
  const address=server.address(); if (!address || typeof address==='string') throw new Error('listen_failed');
  host=`127.0.0.1:${address.port}`; origin=`http://${host}`;
  let mobileServer:ReturnType<typeof createServer>|undefined;
  let closing=false;
  let updating:Promise<void>|undefined;
  const closeMobile=async()=>{
    const current=mobileServer;mobileServer=undefined;mobileOrigin=undefined;mobileHost='';
    if(current)await new Promise<void>((resolve,reject)=>{current.close(error=>error?reject(error):resolve());current.closeIdleConnections();});
  };
  const listenMobile=async()=>{
    if(!mobileAddress)return;
    mobileHost=`${mobileAddress}:${address.port}`;
    const listener=createServer({headersTimeout:5000,requestTimeout:10000,maxHeaderSize:8192},server.listeners('request')[0] as Parameters<typeof createServer>[1]);
    listener.maxConnections=32;
    try{await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen({host:mobileAddress,port:address.port},()=>{listener.off('error',reject);resolve();});});}
    catch(error){mobileHost='';throw error;}
    mobileServer=listener;mobileOrigin=`http://${mobileHost}`;
  };
  try{await listenMobile();}
  catch(error){if(!automatic){await new Promise<void>(resolve=>server.close(()=>resolve()));throw error;}}
  const refreshMobile=async()=>{
    if(closing)return;
    const next=findAddress();
    if(next===mobileAddress&&mobileServer)return;
    await closeMobile();
    mobileAddress=next;
    if(!closing)await listenMobile();
  };
  // The worker controller remains available locally while the VPN starts or reconnects.
  const timer=automatic?setInterval(()=>{
    if(!updating&&!closing)updating=refreshMobile().catch(()=>{ /* Retry only the VPN listener. */ }).finally(()=>{updating=undefined;});
  },5000):undefined;
  return {server,origin,get mobileOrigin(){return mobileOrigin;},issueLaunchUrl,launchUrl:`${origin}/#${nonce}`,close:async()=>{
    closing=true;clearInterval(timer);await updating;
    await Promise.all([closeMobile(),new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();})]);
  }};
}
