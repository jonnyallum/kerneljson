import { writeFileSync } from "node:fs";
import { collectTests } from "./collection.js";

/** CI: the pinned collection at R (27.12.15, CON-47), written for the gate. Refuses on any departure or connection. */
const out=process.argv[2];
if(!out) throw Error("usage: ci-collection <output file>");
const result=await collectTests(process.cwd());
writeFileSync(out,JSON.stringify(result,null,2)+"\n");
console.log(`collected ${result.entries.length} entries from ${new Set(result.entries.map(e=>e.file)).size} files; placeholder connections ${result.acceptedConnections}`);
