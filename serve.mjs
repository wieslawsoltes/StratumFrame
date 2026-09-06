import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url)),port=Number(process.argv[2]||process.env.PORT||8080);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.md':'text/markdown; charset=utf-8','.csv':'text/csv; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    let path=resolve(root,'.'+pathname);if(path!==root.slice(0,-1)&&!path.startsWith(root))throw Object.assign(new Error('Forbidden'),{status:403});
    if((await stat(path)).isDirectory())path=resolve(path,'index.html');
    const data=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(data);
  }catch(e){res.writeHead(e.status||404,{'Content-Type':'text/plain'});res.end(e.status===403?'Forbidden':'Not found');}
});
server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Stratum Frame → http://localhost:${port}`));

server.on('error', error => { console.error(`Server failed: ${error.message}. Pass another port: node serve.mjs 8765`); process.exitCode=1; });
