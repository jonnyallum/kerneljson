import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { HOOK_DEFINITIONS } from "./hook-definitions.js";
import { RegistrySchema, type Registry } from "./hooks.js";
import { REGRESSION_SUITES } from "./plans.js";

/** Generates infrastructure/database/b1-runner-hooks.json from the hook definitions; --check refuses any drift. */
export const REGISTRY_PATH="infrastructure/database/b1-runner-hooks.json";
const sha=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const profile=(id:"pinned-helper"|"platform-definer-fixture",path:string)=>({id,sql:path,sha256:sha(readFileSync(path))});
export function generatedRegistry():Registry{
  return RegistrySchema.parse({
    kind:"kerneljson:b1-runner-hook-registry/v1",
    setupProfiles:[{id:"none",sql:null,sha256:null},
      profile("pinned-helper","docs/operations/evidence/kj-p8-r279-contradiction/pinned-helper.sql"),
      profile("platform-definer-fixture","infrastructure/database/b1-fixture-platform-definers.sql")],
    hooks:HOOK_DEFINITIONS.map(d=>d.hook),
    regressionSuites:[...REGRESSION_SUITES],
  });
}
export const registryText=(registry:Registry)=>JSON.stringify(registry,null,2)+"\n";
if(process.argv[1]?.replaceAll("\\","/").endsWith("scripts/b1/build-hook-registry.ts")){
  const text=registryText(generatedRegistry());
  if(process.argv.includes("--check")){
    if(readFileSync(REGISTRY_PATH,"utf8")!==text){console.error(`${REGISTRY_PATH} differs from the hook definitions`);process.exitCode=1;}
    else console.log(`${REGISTRY_PATH} matches the hook definitions`);
  } else {writeFileSync(REGISTRY_PATH,text);console.log(`wrote ${REGISTRY_PATH}: ${HOOK_DEFINITIONS.length} hooks`);}
}
