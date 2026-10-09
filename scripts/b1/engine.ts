import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/** A URL contains no password. libpq option values need whitespace/backslash escaping before URL encoding. */
export function startupUrl(target:string,declaration:Declaration):string{
  const url=new URL(target);
  if(url.password) throw Error("ENGINE_REFUSED: URL password forbidden");
  if(url.searchParams.has("options")) throw Error("ENGINE_REFUSED: caller startup options forbidden");
  const escape=(s:string)=>s.replace(/([\\\s])/g,"\\$1");
  url.searchParams.set("options",[
    `-c kj.b1.co_resident_set_sha256=${escape(declaration.setSha256)}`,
    `-c kj.b1.target_system_identifier=${escape(declaration.provenance.systemIdentifier)}`,
    `-c kj.b1.target_database=${escape(declaration.provenance.database)}`,
  ].join(" "));
  return url.toString();
}

export async function prepareEngine(release:Release,directory:string){
  const pins=EnginePins.parse(release.json(ENGINE_PINS_PATH));
  const platform=process.platform==="win32" ? "windows-x64" : process.platform==="linux" ? "linux-x64" : null;
  if(!platform || process.arch!=="x64") throw Error("ENGINE_REFUSED: unsupported platform");
  const pin=pins.platforms[platform];
  const expectedNames=platform==="windows-x64" ? ["supabase-go.exe","supabase.exe"] : ["supabase","supabase-go"];
  if(JSON.stringify(Object.keys(pin.executables).sort())!==JSON.stringify(expectedNames.sort())) throw Error("ENGINE_REFUSED: executable set differs");
  const response=await fetch(`https://github.com/supabase/cli/releases/download/v${pins.version}/${pin.archive}`,{signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw Error("ENGINE_REFUSED: archive download failed");
  const archive=Buffer.from(await response.arrayBuffer());
  if(hash(archive)!==pin.sha256) throw Error("ENGINE_REFUSED: archive SHA-256 differs");
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
