import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { hash, HASH, type Declaration } from "../../services/kernel/src/database/co-resident.js";
import { ENGINE_PINS_PATH, type Release } from "./release.js";

const platformPin=z.strictObject({archive:z.string(),sha256:HASH,executables:z.record(z.string(),HASH)});
export const EnginePins=z.strictObject({kind:z.literal("kerneljson:b1-engine-pins/v1"),version:z.literal("2.120.0"),
  platforms:z.strictObject({"linux-x64":platformPin,"windows-x64":platformPin}),image:z.string(),serverVersion:z.string()});

/** H1: build a new environment; parent values cannot add variable names. */
export function engineEnvironment(engineDir:string,home:string,temp:string,windows:boolean,systemRoot?:string,passfile?:string):Record<string,string>{
  const env:Record<string,string>={PATH:engineDir,HOME:home,TMPDIR:temp};
  if(windows){
    if(!systemRoot) throw Error("ENGINE_REFUSED: SystemRoot missing");
    env.USERPROFILE=home;env.TEMP=temp;env.TMP=temp;env.SystemRoot=systemRoot;
  }
  if(passfile) env.PGPASSFILE=passfile;
  return env;
}

export interface StartupSettings {digest?:string|undefined;sysid?:string|undefined;database?:string|undefined}
/**
 * A URL contains no password. libpq option values need whitespace/backslash escaping before URL encoding. A setting
 * left undefined is not sent at all; only the registered S6-apply settings hooks ever leave one out.
 */
export function startupUrlWith(target:string,settings:StartupSettings):string{
  const url=new URL(target);
  if(url.password) throw Error("ENGINE_REFUSED: URL password forbidden");
  if(url.searchParams.has("options")) throw Error("ENGINE_REFUSED: caller startup options forbidden");
  const escape=(s:string)=>s.replace(/([\\\s])/g,"\\$1");
  const options=([["kj.b1.co_resident_set_sha256",settings.digest],["kj.b1.target_system_identifier",settings.sysid],
    ["kj.b1.target_database",settings.database]] as const).filter(([,v])=>v!==undefined).map(([k,v])=>`-c ${k}=${escape(v!)}`);
  if(options.length) url.searchParams.set("options",options.join(" "));
  return url.toString();
}
export function startupUrl(target:string,declaration:Declaration):string{
  return startupUrlWith(target,{digest:declaration.setSha256,sysid:declaration.provenance.systemIdentifier,database:declaration.provenance.database});
}
/** The engine reports a failed statement as `ERROR: <message> (SQLSTATE <code>)`; the last such report is the refusal. */
export function engineRefusal(output:string):{sqlstate:string|null;message:string}{
  const last=[...output.matchAll(/ERROR: (.+?) \(SQLSTATE ([0-9A-Z]{5})\)/g)].at(-1);
  return last?{sqlstate:last[2]!,message:last[1]!}:{sqlstate:null,message:`ENGINE_FAILED: ${output.trim().split(/\r?\n/).at(-1) ?? ""}`};
}
/** The archive is verified against its pinned SHA-256 on every read; the cache only avoids repeating the download. */
async function pinnedArchive(name:string,version:string,sha256:string):Promise<Buffer>{
  const cache=join(tmpdir(),"kj-b1-engine-cache"),path=join(cache,`${sha256}.tar.gz`);
  if(existsSync(path)){const bytes=readFileSync(path);if(hash(bytes)===sha256) return bytes;}
  const response=await fetch(`https://github.com/supabase/cli/releases/download/v${version}/${name}`,{signal:AbortSignal.timeout(180000)});
  if(!response.ok) throw Error("ENGINE_REFUSED: archive download failed");
  const archive=Buffer.from(await response.arrayBuffer());
  if(hash(archive)!==sha256) throw Error("ENGINE_REFUSED: archive SHA-256 differs");
  mkdirSync(cache,{recursive:true});
  const partial=`${path}.${process.pid}.partial`;
  writeFileSync(partial,archive);renameSync(partial,path);
  return archive;
}

export async function prepareEngine(release:Release,directory:string){
  const pins=EnginePins.parse(release.json(ENGINE_PINS_PATH));
  const platform=process.platform==="win32" ? "windows-x64" : process.platform==="linux" ? "linux-x64" : null;
  if(!platform || process.arch!=="x64") throw Error("ENGINE_REFUSED: unsupported platform");
  const pin=pins.platforms[platform];
  const expectedNames=platform==="windows-x64" ? ["supabase-go.exe","supabase.exe"] : ["supabase","supabase-go"];
  if(JSON.stringify(Object.keys(pin.executables).sort())!==JSON.stringify(expectedNames.sort())) throw Error("ENGINE_REFUSED: executable set differs");
  const archive=await pinnedArchive(pin.archive,pins.version,pin.sha256);
  mkdirSync(directory,{mode:0o700});
  const engineDir=join(directory,"engine"),home=join(directory,"home"),temp=join(directory,"tmp");
  for(const path of [engineDir,home,temp]) mkdirSync(path,{mode:0o700});
  const tar=gunzipSync(archive), found=new Set<string>();
  for(let pos=0;pos+512<=tar.length;){
    const header=tar.subarray(pos,pos+512);if(header.every(b=>b===0)) break;
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,"").replace(/^\.\//,"");
    const size=Number.parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,"").trim(),8);
    if(!Number.isSafeInteger(size) || size<0 || pos+512+size>tar.length) throw Error("ENGINE_REFUSED: invalid archive member");
    if(Object.hasOwn(pin.executables,name)){
      if(found.has(name) || ![0,48].includes(header[156]!)) throw Error("ENGINE_REFUSED: executable is not a unique regular file");
      const bytes=tar.subarray(pos+512,pos+512+size);
      if(hash(bytes)!==pin.executables[name]) throw Error("ENGINE_REFUSED: executable SHA-256 differs");
      writeFileSync(join(engineDir,name),bytes,{flag:"wx",mode:0o700});found.add(name);
    }
    pos+=512+Math.ceil(size/512)*512;
  }
  if(found.size!==2 || readdirSync(engineDir).length!==2) throw Error("ENGINE_REFUSED: executable set incomplete");
  const launcher=resolve(engineDir,platform==="windows-x64" ? "supabase.exe" : "supabase");
  const env=engineEnvironment(engineDir,home,temp,platform==="windows-x64",process.env.SystemRoot);
  const verifyCopies=()=>{
    if(JSON.stringify(readdirSync(engineDir).sort())!==JSON.stringify(expectedNames.sort())) throw Error("ENGINE_REFUSED: extra executable directory member");
    for(const name of expectedNames) if(hash(readFileSync(join(engineDir,name)))!==pin.executables[name]) throw Error("ENGINE_REFUSED: copied executable changed");
  };
  verifyCopies();
  const version=spawnSync(launcher,["--version"],{env,encoding:"utf8",timeout:60000,windowsHide:true});
  if(version.status!==0 || version.stdout.trim()!==pins.version) throw Error("ENGINE_REFUSED: copied launcher version differs");
  return {
    pins,platform,executableHashes:pin.executables,
    apply(exportDirectory:string,url:string,passfile?:string){
      verifyCopies();
      if(new URL(url).password) throw Error("ENGINE_REFUSED: URL password forbidden");
      const childEnv=engineEnvironment(engineDir,home,temp,platform==="windows-x64",process.env.SystemRoot,passfile);
      const result=spawnSync(launcher,["migration","up","--workdir",exportDirectory,"--db-url",url],
        {env:childEnv,encoding:"utf8",timeout:300000,windowsHide:true,maxBuffer:16*1024*1024});
      return {exitStatus:result.status,signal:result.signal,error:result.error?.message ?? null,
        stdout:result.stdout,stderr:result.stderr,environmentNames:Object.keys(childEnv).sort()};
    },
  };
}
