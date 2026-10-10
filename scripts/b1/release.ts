import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash } from "../../services/kernel/src/database/co-resident.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { STAGE_MANIFEST_PATH, stageBindingProblems, type StageManifest } from "../../services/kernel/src/database/security-definers.js";
import { expectedLedgerVersions, SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";

export const B1_FILE="20261002090000_runtime_least_privilege_roles.sql";
export const ENGINE_PINS_PATH="infrastructure/database/b1-engine-pins.json";
export const HOOKS_PATH="infrastructure/database/b1-runner-hooks.json";
export class Release {
  constructor(readonly root:string,readonly R:string) {
    if(!/^[0-9a-f]{40}$/.test(R)) throw Error("RELEASE_REFUSED: R must be an exact commit SHA");
    if(this.git(["rev-parse","HEAD"]).toString().trim()!==R) throw Error("RELEASE_REFUSED: HEAD differs from R");
    const status=this.git(["status","--porcelain=v1","-z","--untracked-files=all"]).toString().split("\0").filter(Boolean);
    if(status.some(s=>!s.startsWith("?? ") || s.slice(3).startsWith("supabase/migrations/")))
      throw Error("RELEASE_REFUSED: tracked changes or untracked migration");
    const flags=this.git(["ls-files","-v","-z"]).toString().split("\0").filter(Boolean);
    if(flags.some(s=>s[0]!=="H")) throw Error("RELEASE_REFUSED: flagged tracked path");
  }
  git(args:string[]):Buffer {
    const r=spawnSync("git",args,{cwd:this.root,maxBuffer:64*1024*1024,windowsHide:true});
    if(r.status!==0 || r.error) throw Error("RELEASE_REFUSED: git operation failed");
    return r.stdout;
  }
  blob(path:string):{id:string;sha256:string;bytes:Buffer} {
    if(path.startsWith("/") || path.includes("..") || /[\0\r\n\\]/.test(path)) throw Error("RELEASE_REFUSED: invalid blob path");
    const id=this.git(["rev-parse",`${this.R}:${path}`]).toString().trim();
    const bytes=this.git(["cat-file","blob",id]);
    return {id,sha256:hash(bytes),bytes};
  }
  json(path:string):unknown {return strictJson(this.blob(path).bytes.toString("utf8"));}
  migrations():{manifest:StageManifest;files:Map<string,ReturnType<Release["blob"]>>} {
    const manifest=this.json(STAGE_MANIFEST_PATH) as StageManifest;
    const names=this.git(["ls-tree","-r","--name-only",this.R,"--","supabase/migrations/"]).toString().trim().split("\n");
    const files=new Map<string,ReturnType<Release["blob"]>>();
    for(const path of names){
      const file=path.slice("supabase/migrations/".length);
      if(!/^[0-9]{14}_[a-z0-9_]+\.sql$/.test(file)) throw Error("RELEASE_REFUSED: unexpected migration path");
      files.set(file,this.blob(path));
    }
    if(manifest.declaredStage!=="B1" || manifest.baseMigrations.length!==22 || files.size!==23 || !files.has(B1_FILE))
      throw Error("RELEASE_REFUSED: exact B1 migration set required");
    if(JSON.stringify(expectedLedgerVersions(manifest))!==JSON.stringify(SEALED_BASE_VERSIONS)) throw Error("RELEASE_REFUSED: sealed base versions differ");
    const problems=stageBindingProblems(manifest,new Map([...files].map(([name,b])=>[name,b.sha256])));
    if(problems.length) throw Error(`RELEASE_REFUSED: ${problems.join("; ")}`);
    return {manifest,files};
  }
  exportMigrations(directory:string,baseOnly=false):{file:string;sha256:string;blob:string}[] {
    const {files}=this.migrations();
    mkdirSync(directory,{mode:0o700});
    mkdirSync(join(directory,"supabase"),{mode:0o700});
    mkdirSync(join(directory,"supabase","migrations"),{mode:0o700});
    const config=this.blob("supabase/config.toml");
    writeFileSync(join(directory,"supabase","config.toml"),config.bytes,{flag:"wx",mode:0o600});
    const exported=[];
    for(const [file,blob] of files){
      if(baseOnly && file===B1_FILE) continue;
      const path=join(directory,"supabase","migrations",file);
      writeFileSync(path,blob.bytes,{flag:"wx",mode:0o600});
      if(hash(readFileSync(path))!==blob.sha256) throw Error("RELEASE_REFUSED: exported bytes differ");
      exported.push({file,sha256:blob.sha256,blob:blob.id});
    }
    if(hash(readFileSync(join(directory,"supabase","config.toml")))!==config.sha256) throw Error("RELEASE_REFUSED: exported config differs");
    return exported;
  }
  /**
   * Immediately before the engine runs: the export directory holds exactly the exported files with their blob bytes.
   * `replaced` names the one file a registered S6-apply variant hook substituted, which is recorded instead.
   */
  verifyExport(directory:string,exported:readonly {file:string;sha256:string}[],replaced?:string):void{
    const names=readdirSync(join(directory,"supabase","migrations")).sort();
    if(JSON.stringify(names)!==JSON.stringify(exported.map(f=>f.file).sort())) throw Error("RELEASE_REFUSED: exported bytes differ: file set changed");
    for(const f of exported){
      if(f.file===replaced) continue;
      if(hash(readFileSync(join(directory,"supabase","migrations",f.file)))!==f.sha256) throw Error(`RELEASE_REFUSED: exported bytes differ: ${f.file}`);
    }
  }
}
