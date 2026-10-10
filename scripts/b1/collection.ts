import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { hash } from "../../services/kernel/src/database/co-resident.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";

export const COLLECTION_ARGS=["node_modules/vitest/vitest.mjs","list","--no-static-parse","--includeTaskLocation","--json"] as const;
export const COLLECTION_FLAGS={S1R_LIVE:"1",S1B_REARM_LIVE:"1",S1R_RUNTIME:"1",KJ_GATE3_LIVE:"1",
  KJ_TEST_PG_URL:"postgresql://kj_collect_placeholder@127.0.0.1:54999/kj_collect_placeholder"} as const;
export function collectionEnvironment(platform:NodeJS.Platform,parent:NodeJS.ProcessEnv):Record<string,string>{
  const names=platform==="win32"?["PATH","SystemRoot","TEMP","TMP","USERPROFILE","APPDATA"]:
    platform==="linux"?["PATH","HOME","TMPDIR"]:null;
  if(!names) throw Error("COLLECTION_REFUSED: unsupported platform");
  const env:Record<string,string>={};
  for(const name of names){
    const key=platform==="win32"?Object.keys(parent).find(k=>k.toLowerCase()===name.toLowerCase()):name;
    const value=key?parent[key]:undefined;
    if(!value) throw Error(`COLLECTION_REFUSED: required platform variable ${name} absent`);
    env[name]=value;
  }
  return {...env,...COLLECTION_FLAGS};
}
const Location=z.strictObject({line:z.number().int().positive(),column:z.number().int().positive()});
const Entry=z.strictObject({name:z.string().min(1),file:z.string().min(1),location:Location});
export type CollectedEntry=z.infer<typeof Entry>;
export function parseCollection(raw:string,root:string):CollectedEntry[]{
  const rows=z.array(Entry).min(1).parse(strictJson(raw));
  return rows.map(row=>{
    const file=relative(resolve(root),resolve(row.file)).replaceAll("\\","/");
    if(!/^tests\/[^/]+\.test\.ts$/.test(file)) throw Error("COLLECTION_REFUSED: unexpected collected file");
    return {...row,file};
  }).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:a.location.line-b.location.line || a.location.column-b.location.column || (a.name<b.name?-1:a.name>b.name?1:0));
}
export async function collectTests(root:string){
  if(process.versions.node!==readFileSync(join(root,".node-version"),"utf8").trim()) throw Error("COLLECTION_REFUSED: Node version differs");
  const pkg=strictJson(readFileSync(join(root,"node_modules/vitest/package.json"),"utf8")) as {version:string};
  if(pkg.version!=="5.0.0") throw Error("COLLECTION_REFUSED: Vitest version differs");
  const env=collectionEnvironment(process.platform,process.env);
  let accepted=0;
  const listener=createServer(socket=>{accepted++;socket.destroy();});
  await new Promise<void>((yes,no)=>{listener.once("error",no);listener.listen(54999,"127.0.0.1",yes);});
  let stdout="",stderr="";
  try{
    const code=await new Promise<number|null>((yes,no)=>{
      const child=spawn(process.execPath,[...COLLECTION_ARGS],{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      const timer=setTimeout(()=>{child.kill();no(Error("COLLECTION_REFUSED: collection timed out"));},900000);
      const consume=(channel:"stdout"|"stderr",chunk:string)=>{
        if(channel==="stdout") stdout+=chunk;else stderr+=chunk;
        if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>32*1024*1024){child.kill();no(Error("COLLECTION_REFUSED: output limit exceeded"));}
      };
      child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
      child.stdout.on("data",chunk=>consume("stdout",chunk));child.stderr.on("data",chunk=>consume("stderr",chunk));
      child.once("error",error=>{clearTimeout(timer);no(error);});child.once("close",code=>{clearTimeout(timer);yes(code);});
    });
    if(code!==0 || stderr.trim()) throw Error(`COLLECTION_REFUSED: collection failed (${code}): ${stderr.slice(0,1000)}`);
    if(accepted!==0) throw Error("COLLECTION_REFUSED: collection connected to placeholder");
    const entries=parseCollection(stdout,root);
    return {kind:"kerneljson:test-collection/v1" as const,node:process.versions.node,vitest:pkg.version,
      command:["node",...COLLECTION_ARGS],environmentNames:Object.keys(env).sort(),flags:COLLECTION_FLAGS,
      acceptedConnections:accepted,entriesSha256:hash(JSON.stringify(entries)),entries};
  }finally{await new Promise<void>((yes,no)=>listener.close(error=>error?no(error):yes()));}
}
