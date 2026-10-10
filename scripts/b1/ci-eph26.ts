import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { strictJson } from "../../services/kernel/src/database/strict-json.js";
import { readRunRecord } from "./evidence.js";
import { Release } from "./release.js";
import { readFileSync } from "node:fs";

/**
 * ADR-0023 27.12.13.9 EPH-26 (b), end to end: a clean, unhooked run whose L2 is refused by a condition induced only
 * from outside the runner (the CI job removes the pinned image and blocks registry pulls before invoking it). The run
 * must be NOT_QUALIFIED with zero applications against one planned, L2 refused, L6 passed, and the consumer's
 * recomputation must agree. Usage: ci-eph26 <R> <evidence directory written by ci-stage-t>.
 */
const [R,dir]=process.argv.slice(2);
const {summary}=strictJson(readFileSync(join(dir!,"summary.json"),"utf8")) as {summary:{recordSha256?:string}};
const record=readRunRecord(join(dir!,"run","record.json"),summary.recordSha256 ?? "",new Release(process.cwd(),R!));
const refused=record.events.filter(e=>e.outcome==="refused").map(e=>e.step);
const problems:string[]=[];
if(record.status!=="NOT_QUALIFIED") problems.push(`status ${record.status}`);
if(record.header.hookIds.length || record.negativeFixture) problems.push("the run carried a hook");
if(JSON.stringify(refused)!==JSON.stringify(["L2"])) problems.push(`refused steps ${JSON.stringify(refused)}, expected exactly L2`);
if(record.applications.length!==0 || record.plannedApplications.length<1) problems.push("applications differ");
if(!(record.events.at(-1)?.step==="L6" && record.events.at(-1)?.outcome==="passed")) problems.push("L6 not recorded passed");
if(problems.length){console.error(`EPH-26 (b) failed: ${problems.join("; ")}`);process.exitCode=1;}
else{writeFileSync(join(dir!,"eph26-passed"),"EPH-26 (b) passed\n");console.log("EPH-26 (b): NOT_QUALIFIED, refused at L2 only, teardown passed, consumer agrees");}
