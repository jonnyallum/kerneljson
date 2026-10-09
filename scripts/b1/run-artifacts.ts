import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { hash, parseDeclaration, type Declaration } from "../../services/kernel/src/database/co-resident.js";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { artifactPairProblems, BaselineSchema, baselineProblems, type PlatformBaseline, type StageManifest } from "../../services/kernel/src/database/security-definers.js";

export function freezeArtifacts(directory:string,application:number,pair:{baseline:PlatformBaseline;declaration:Declaration},manifest:StageManifest){
  if(!Number.isInteger(application) || application<1) throw Error("ARTIFACT_REFUSED: application invalid");
  if(pair.baseline.mode!=="EPHEMERAL_RUN_BOUND" || pair.declaration.mode!=="EPHEMERAL_RUN_BOUND" ||
    pair.baseline.run?.application!==application || pair.declaration.run.application!==application) throw Error("ARTIFACT_REFUSED: mode or application differs");
  const problems=[...baselineProblems(pair.baseline,manifest),...artifactPairProblems(pair.baseline,pair.declaration)];
  if(problems.length) throw Error(`ARTIFACT_REFUSED: ${problems.join("; ")}`);
  const frozenRun=JSON.stringify(pair.declaration.run);
  const files={baseline:join(directory,`${application}-baseline.json`),declaration:join(directory,`${application}-declaration.json`)};
  const digests:{baseline:string;declaration:string}={baseline:"",declaration:""};
  for(const key of ["baseline","declaration"] as const){
    const bytes=Buffer.from(JSON.stringify(pair[key],null,2)+"\n");
    writeFileSync(files[key],bytes,{flag:"wx",mode:0o600});digests[key]=hash(bytes);
  }
  const read=()=>{
    const bytes:{baseline:Buffer;declaration:Buffer}={baseline:Buffer.alloc(0),declaration:Buffer.alloc(0)};
    for(const key of ["baseline","declaration"] as const){
      const stat=lstatSync(files[key]);
      if(!stat.isFile() || stat.isSymbolicLink()) throw Error("ARTIFACT_REFUSED: run artifact is not a regular file");
      bytes[key]=readFileSync(files[key]);
      if(hash(bytes[key])!==digests[key]) throw Error(`ARTIFACT_REFUSED: ${key} bytes changed after S3`);
    }
    const baseline=BaselineSchema.parse(strictJson(bytes.baseline.toString("utf8"))),declaration=parseDeclaration(bytes.declaration.toString("utf8"));
    if(baseline.mode!=="EPHEMERAL_RUN_BOUND" || declaration.mode!=="EPHEMERAL_RUN_BOUND" ||
      JSON.stringify(baseline.run)!==frozenRun || JSON.stringify(declaration.run)!==frozenRun) throw Error("ARTIFACT_REFUSED: run binding changed");
    const invalid=[...baselineProblems(baseline,manifest),...artifactPairProblems(baseline,declaration)];
    if(invalid.length) throw Error(`ARTIFACT_REFUSED: ${invalid.join("; ")}`);
    return {baseline,declaration};
  };
  read();return {files:Object.freeze(files),digests:Object.freeze(digests),read};
}
