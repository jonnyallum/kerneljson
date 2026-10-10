import { describe, it } from "vitest";
import { CASE_TIMEOUT, expectFixturePassed, runCase } from "./support/b1-runner.js";
import type { Profile } from "../scripts/b1/hooks.js";

/**
 * ADR-0023 27.12.7 P3 and 27.12.9 cases 16, 19, 24 to 30, 38 and 26: the three startup settings, supplied only by the
 * registered S6-apply settings hooks (27.12.13.8), through the pinned engine on runner-created clusters. A setting
 * left out is not sent at all. Each refusal must be 23514 at the named P3 step; 22P02 or any other SQLSTATE fails.
 * Case 19 runs on the helper target, cases 24 and 25 on the empty target; every combination runs on both.
 */
const t=(label:string,profile:Profile,hooks:string[])=>
  it.concurrent(label,async()=>{expectFixturePassed(await runCase(label,profile,hooks));},CASE_TIMEOUT);

describe.concurrent("P3 step 1: presence",()=>{
  for(const profile of ["pinned-helper","none"] as const){
    const target=profile==="none"?"empty target (24, 25)":"helper target (19)";
    t(`no settings, ${target}`,profile,["settings-none"]);
    t(`only the digest, ${target}`,profile,["settings-only-digest"]);
    t(`only the system identifier, ${target}`,profile,["settings-only-sysid"]);
    t(`only the database, ${target}`,profile,["settings-only-database"]);
    t(`all but the digest, ${target}`,profile,["settings-without-digest"]);
    t(`all but the system identifier, ${target}`,profile,["settings-without-sysid"]);
    t(`all but the database, ${target}`,profile,["settings-without-database"]);
    t(`empty digest, ${target}`,profile,["settings-empty-digest"]);
    t(`empty system identifier, ${target}`,profile,["settings-empty-sysid"]);
    t(`empty database, ${target}`,profile,["settings-empty-database"]);
  }
});
describe.concurrent("P3 step 2: format, never by cast",()=>{
  for(const profile of ["none","pinned-helper"] as const){
    t(`27 system identifier abc, ${profile}`,profile,["settings-sysid-abc"]);
    t(`27 system identifier 0123, ${profile}`,profile,["settings-sysid-leading-zero"]);
    t(`27 system identifier leading space, ${profile}`,profile,["settings-sysid-leading-space"]);
    t(`27 system identifier trailing space, ${profile}`,profile,["settings-sysid-trailing-space"]);
    t(`27 system identifier 20 digits, ${profile}`,profile,["settings-sysid-twenty-digits"]);
    t(`27 system identifier decimal, ${profile}`,profile,["settings-sysid-decimal"]);
    t(`28 digest uppercase, ${profile}`,profile,["settings-digest-uppercase"]);
    t(`28 digest 63 characters, ${profile}`,profile,["settings-digest-sixty-three"]);
    t(`28 digest 65 characters, ${profile}`,profile,["settings-digest-sixty-five"]);
    t(`28 digest non-hexadecimal, ${profile}`,profile,["settings-digest-non-hex"]);
    t(`29 database 64 bytes, ${profile}`,profile,["settings-database-sixty-four-bytes"]);
    t(`29 database control character, ${profile}`,profile,["settings-database-control-character"]);
  }
});
describe.concurrent("P3 steps 3 to 5, and P2 before P3",()=>{
  for(const profile of ["none","pinned-helper"] as const){
    t(`30 another database, ${profile}`,profile,["settings-database-other"]);
    t(`16 another system identifier, ${profile}`,profile,["settings-sysid-other"]);
  }
  t("38 helper target given the empty-set digest","pinned-helper",["settings-digest-empty-set"]);
  t("19 helper declaration applied to the empty target","none",["settings-digest-golden"]);
  t("26 fn-only digest on an intact helper target refuses at P3 step 5","pinned-helper",["settings-digest-fn-only"]);
  t("26 ensure_rls dropped with the fn-only digest names P2, not P3","pinned-helper",["settings-digest-fn-only","drift-ensure-rls-dropped","gate-inventory-skip"]);
});
