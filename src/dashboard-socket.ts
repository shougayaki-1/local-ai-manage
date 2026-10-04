import { privateIPv4, tailscaleIPv4 } from './server.ts';
import { createServer, createConnection } from 'node:net';
import { chmod, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
async function privateDirectory(directory:string){const path=resolve(directory);const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||await realpath(path)!==path)throw new Error('unsafe_dashboard_directory');return path;}
function launchUrl(value:string){if(!/^http:\/\/[0-9.]+:[1-9]\d{0,4}\/#(?:[a-f0-9]{64})$/.test(value)||Number(new URL(value).port)>65535||(new URL(value).hostname!=='127.0.0.1'&&!privateIPv4(new URL(value).hostname)&&!tailscaleIPv4(new URL(value).hostname)))throw new Error('invalid_dashboard_link');return value;}
/** Local owner-only IPC: issues a fresh login link; never accepts shell or control commands. */
export async function startDashboardSocket(directory:string,issueLink:(mobile?:boolean)=>string){
 const path=join(await privateDirectory(directory),'dashboard.sock');
 // Restrictive umask avoids a public socket between bind and chmod. CLI startup is single-threaded here.
 const previous=process.umask(0o077);
 const server=createServer(socket=>{let body='';socket.setTimeout(1000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',chunk=>{body+=chunk.toString();if(body.length>7){socket.destroy();return;}if(body==='OPEN\n'||body==='MOBILE\n'){try{socket.end(launchUrl(issueLink(body==='MOBILE\n'))+'\n');}catch{socket.destroy();}}else if(body.includes('\n'))socket.destroy();});});
 server.maxConnections=4;
 try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});await chmod(path,0o600);}catch(error){server.close();throw error;}finally{process.umask(previous);}
 return {close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
export async function dashboardLaunchUrl(directory:string,mobile=false):Promise<string>{
 const path=join(await privateDirectory(directory),'dashboard.sock');const info=await lstat(path);if(!info.isSocket()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new Error('unsafe_dashboard_socket');
 return new Promise((resolve,reject)=>{let body='';const socket=createConnection(path);socket.setTimeout(2000,()=>socket.destroy(new Error('dashboard_unavailable')));socket.on('error',()=>reject(new Error('dashboard_unavailable')));socket.on('connect',()=>socket.write(mobile?'MOBILE\n':'OPEN\n'));socket.on('data',chunk=>{body+=chunk.toString();if(body.length>128)socket.destroy(new Error('invalid_dashboard_link'));});socket.on('end',()=>{try{resolve(launchUrl(body.trim()));}catch(error){reject(error);}});});
}
