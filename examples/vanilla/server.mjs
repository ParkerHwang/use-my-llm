import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const dir=path.dirname(fileURLToPath(import.meta.url));
const files=new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/app.js',['app.js','text/javascript; charset=utf-8']],
  ['/sdk.js',['../../packages/browser/dist/index.js','text/javascript; charset=utf-8']]
]);
const server=http.createServer(async(req,res)=>{
  const item=files.get(new URL(req.url,'http://localhost').pathname);
  if(req.method!=='GET'||!item){res.writeHead(404).end();return;}
  try {const content=await readFile(path.resolve(dir,item[0]));res.writeHead(200,{'Content-Type':item[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);}
  catch {res.writeHead(500).end('Example is unavailable.');}
});
server.listen(5173,'127.0.0.1',()=>console.log('Example: http://127.0.0.1:5173/'));
