"use strict";
// Standalone loopback-only research service. No production configuration imported.
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto"),V=require("../strategy/hypothesis_v5/service");
function start({directory=path.resolve(".v5-research/standalone"),port=3311}={}){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const auth=path.join(directory,"research-access.json");
 if(!fs.existsSync(auth))fs.writeFileSync(auth,JSON.stringify({access:crypto.randomBytes(32).toString("base64url")}),{mode:0o600,flag:"wx"});
 const access=JSON.parse(fs.readFileSync(auth)).access;if(typeof access!=="string"||access.length<32)throw Error("研究认证无效");
 const lock=path.join(directory,"process.lock");try{fs.writeFileSync(lock,String(process.pid),{flag:"wx",mode:0o600});}catch{const pid=Number(fs.readFileSync(lock));try{process.kill(pid,0);throw Error("研究目录已被进程使用");}catch(e){if(e.code!=="ESRCH")throw e;fs.unlinkSync(lock);fs.writeFileSync(lock,String(process.pid),{flag:"wx",mode:0o600});}}
 const service=V.createService({directory:path.join(directory,"state")}),publicDir=path.resolve(__dirname,"../public");
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,"http://localhost");if(url.pathname.startsWith("/api/v5/")){
   const supplied=Buffer.from(String(req.headers.authorization||"").replace(/^Bearer /,"")),expected=Buffer.from(access);if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){res.writeHead(401);return res.end('{"ok":false,"error":"研究访问凭据缺失"}');}
   if(req.headers.origin&&!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)){res.writeHead(403);return res.end();}
   return V.handle(req,res,url,service);
  }
  const names={"/":"/intelligent-trend.html","/intelligent-trend.html":"/intelligent-trend.html","/hypothesis/workbench.js":"/hypothesis/workbench.js","/hypothesis/workbench.css":"/hypothesis/workbench.css"};
  const name=names[url.pathname];if(!name){res.writeHead(404);return res.end();}res.setHeader("Content-Type",name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":"text/html");res.end(fs.readFileSync(publicDir+name));
 });
 server.listen(port,"127.0.0.1",()=>console.log("H01 Shadow loopback http://127.0.0.1:"+port+"; access file: "+auth+"; no accounts auto-created"));
 const stop=()=>{server.close();service.stop();if(fs.existsSync(lock)&&fs.readFileSync(lock,"utf8")===String(process.pid))fs.unlinkSync(lock);};
 server.on("error",()=>stop());return{server,service,stop};
}
if(require.main===module){const x=start({directory:process.argv[2]?path.resolve(process.argv[2]):undefined,port:process.argv[3]?Number(process.argv[3]):3311});for(const s of ["SIGINT","SIGTERM"])process.on(s,()=>{x.stop();process.exit(0);});}
module.exports={start};
