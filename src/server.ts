import type { ReadinessReport } from './readiness.ts';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { ControlError, type Controller } from './controller.ts';
import type { Snapshot } from './types.ts';
const equal=(a: string,b: string) => a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req: IncomingMessage): Promise<unknown> {
  let content='';
  for await (const chunk of req) { content+=chunk.toString(); if (Buffer.byteLength(content)>2048) throw new Error('body_limit'); }
  return JSON.parse(content);
}
export async function startServer({snapshot,webDirectory,port=0,now=Date.now,controller,readiness}:{snapshot:()=>Promise<Snapshot>;webDirectory:string;port?:number;now?:()=>number;controller?:Controller;readiness?:()=>Promise<ReadinessReport>}) {
  const web=await realpath(webDirectory);
  if (!(await stat(join(web,'index.html'))).isFile()) throw new Error('build_required');
  const nonce=randomBytes(32).toString('hex'); const session=randomBytes(32).toString('hex');
  const csrf=randomBytes(32).toString('hex'); let writeWindow=now();let writeCount=0;
  const started=now(); let redeemed=false; let attempts=0; let inFlight: Promise<Snapshot>|null=null;
  let origin=''; let host=''; let readWindow=now(); let readCount=0;
  const server=createServer({headersTimeout:5000,requestTimeout:10000,maxHeaderSize:8192}, async(req,res)=>{
    const send=(code:number,value:unknown)=>{ res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.socket.remoteAddress!=='127.0.0.1' || req.headers.host!==host || (req.headers.origin!==undefined && req.headers.origin!==origin) || req.headers['sec-fetch-site']==='cross-site' || !req.url?.startsWith('/') || req.url.startsWith('//')) return send(403,{error:'request_rejected'});
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
        redeemed=true; res.setHeader('Set-Cookie',`lam_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(200,{authenticated:true,csrf});
      }
      if (controller && (url.pathname==='/api/controls' || url.pathname==='/api/csrf' || url.pathname.startsWith('/api/requests/'))) {
        const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lam_session='))?.slice(12) ?? '';
        if (!redeemed || now()-started>28_800_000 || !equal(cookie,session)) return send(401,{error:'authentication_required'});
        if (req.method==='GET') {
          if(now()-readWindow>=60_000){readWindow=now();readCount=0;}
          if(++readCount>120)return send(429,{error:'rate_limited'});
        }
        if (url.pathname==='/api/csrf' && req.method==='GET') return send(200,{csrf});
        const ack=url.pathname.match(/^\/api\/requests\/([0-9a-f-]{36})$/);
        if (ack && req.method==='GET') {const value=controller.ack(ack[1]!);return value?send(200,value):send(404,{error:'not_found'});}
        if (url.pathname!=='/api/controls' || req.method!=='POST') return send(405,{error:'method_not_allowed'});
        if (req.headers.origin!==origin || req.headers['content-type']!=='application/json' || typeof req.headers['x-local-csrf']!=='string' || !equal(req.headers['x-local-csrf'],csrf)) return send(403,{error:'request_rejected'});
        if (now()-writeWindow>=60_000) {writeWindow=now();writeCount=0;}
        if (++writeCount>30) return send(429,{error:'rate_limited'});
        try {return send(200,await controller.apply(await body(req)));}
        catch(error) {if(error instanceof ControlError)return send(error.status,{error:error.message});return send(503,{error:'control_unavailable'});}
      }
      if (req.method!=='GET') return send(405,{error:'method_not_allowed'});
      if (url.pathname.startsWith('/api/')) {
        const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lam_session='))?.slice(12) ?? '';
        if (!redeemed || now()-started>28_800_000 || !equal(cookie,session)) return send(401,{error:'authentication_required'});
        if (now()-readWindow>=60_000) { readWindow=now(); readCount=0; }
        if (++readCount>120) return send(429,{error:'rate_limited'});
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
  return {server,origin,launchUrl:`${origin}/#${nonce}`,close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();})};
}
