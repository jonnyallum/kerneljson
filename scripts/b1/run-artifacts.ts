import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, parseDeclaration, type Declaration } from "../../services/kernel/src/database/co-resident.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { artifactPairProblems, BaselineSchema, baselineProblems, canonicalJson, type PlatformBaseline, type StageManifest } from "../../services/kernel/src/database/security-definers.js";

type Key="baseline"|"declaration";
const KEYS:readonly Key[]=["baseline","declaration"];
export interface RunBindingValue {runId:string;clusterNonce:string;containerId:string;containerCreated:string;application:number}
const refuse=(message:string):never=>{throw Error(`ARTIFACT_REFUSED: ${message}`);};
const message=(error:unknown)=>error instanceof Error?error.message.split("\n")[0]!:String(error);

/**
 * 27.12.13.4 S3 to S7. Both files are written once, mode 0600, and their SHA-256s kept in the runner's memory. Every
 * later read requires those digests. Only the registered S3-files hooks may re-record a digest, and doing so makes the
 * run a negative fixture.
 */
export function freezeArtifacts(directory:string,application:number,pair:{baseline:PlatformBaseline;declaration:Declaration},manifest:StageManifest){
  if(!Number.isInteger(application) || application<1) refuse("application invalid");
  if(pair.baseline.mode!=="EPHEMERAL_RUN_BOUND" || pair.declaration.mode!=="EPHEMERAL_RUN_BOUND" ||
    pair.baseline.run?.application!==application || pair.declaration.run.application!==application) refuse("mode or application differs");
  const problems=[...baselineProblems(pair.baseline,manifest),...artifactPairProblems(pair.baseline,pair.declaration)];
  if(problems.length) refuse(problems.join("; "));
  const files:Record<Key,string>={baseline:join(directory,`${application}-baseline.json`),declaration:join(directory,`${application}-declaration.json`)};
  const digests:Record<Key,string>={baseline:"",declaration:""};
  for(const key of KEYS){
    const bytes=Buffer.from(JSON.stringify(pair[key],null,2)+"\n");
    writeFileSync(files[key],bytes,{flag:"wx",mode:0o600});digests[key]=hash(bytes);
  }
  const bytesOf=():Record<Key,Buffer>=>{
    const out={} as Record<Key,Buffer>;
    for(const key of KEYS){
      if(!existsSync(files[key])) refuse(`${key} is missing`);
      const stat=lstatSync(files[key]);
      if(!stat.isFile() || stat.isSymbolicLink()) refuse(`${key} is not a regular file`);
      out[key]=readFileSync(files[key]);
      if(hash(out[key])!==digests[key]) refuse(`${key} bytes changed after S3`);
    }
    return out;
  };
  const parse=(bytes:Record<Key,Buffer>)=>{
    let declaration:Declaration,baseline:PlatformBaseline;
    try{declaration=parseDeclaration(bytes.declaration.toString("utf8"));}catch(error){return refuse(`declaration invalid: ${message(error)}`);}
    try{baseline=BaselineSchema.parse(strictJson(bytes.baseline.toString("utf8")));}catch(error){return refuse(`baseline invalid: ${message(error)}`);}
    const invalid=baselineProblems(baseline,manifest);
    if(invalid.length) refuse(`baseline invalid: ${invalid.join("; ")}`);
    return {baseline,declaration};
  };
  return {
    files:Object.freeze({...files}),
    digests:()=>({...digests}),
    /** S6 and S7: the recorded digests, then the exact schemas. */
    read:()=>parse(bytesOf()),
    /** S4: everything read() checks, plus the run binding and the live identity read at L5. */
    validate(expected:RunBindingValue,live:{systemIdentifier:string;database:string}){
      const value=parse(bytesOf());
      const want=canonicalJson(expected);
      const differs=KEYS.filter(k=>{const run=k==="baseline"?value.baseline.run:"run" in value.declaration?value.declaration.run:null;return value[k].mode!=="EPHEMERAL_RUN_BOUND" || canonicalJson(run ?? null)!==want;});
      if(differs.length) refuse(`run binding differs from this run and application: ${differs.join(", ")}`);
      const pair=artifactPairProblems(value.baseline,value.declaration);
      if(pair.length) refuse(`artifact pair differs: ${pair.join("; ")}`);
      if(value.declaration.provenance.systemIdentifier!==live.systemIdentifier || value.declaration.provenance.database!==live.database)
        refuse("system identifier or database differs from the live values read at L5");
      return value;
    },
    /** Registered S3-files hooks only: record the digest of a file the hook rewrote. */
    rerecord(key:Key){digests[key]=existsSync(files[key])?hash(readFileSync(files[key])):"";},
  };
}
export type FrozenArtifacts=ReturnType<typeof freezeArtifacts>;
