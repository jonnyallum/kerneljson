import { z } from "zod";
import { HASH } from "../../services/kernel/src/database/co-resident.js";
import { SEALED_BASE_VERSIONS } from "../../services/kernel/src/database/ledger-contract.js";

// Hooks expose SQL bytes, never connection credentials, a client, or connection creation.
export const LEDGER_EFFECTS=["ledger-absent","ledger-wrong-head","ledger-gap","ledger-extra","ledger-b1-recorded","stamp-missing"] as const;
export type LedgerEffect=typeof LEDGER_EFFECTS[number];
export function ledgerHook(effect:LedgerEffect):{sql:string;message:string}{
  const prefix="PLATFORM_BASELINE_REFUSED: ";
  switch(effect){
    case "ledger-absent":return {sql:"alter table supabase_migrations.schema_migrations rename to fixture_hidden_ledger",
      message:prefix+"the migration ledger supabase_migrations.schema_migrations does not exist"};
    case "ledger-wrong-head":return {sql:`delete from supabase_migrations.schema_migrations where version='${SEALED_BASE_VERSIONS.at(-1)}'`,
      message:prefix+`the migration ledger head is ${SEALED_BASE_VERSIONS.at(-2)}, not ${SEALED_BASE_VERSIONS.at(-1)}, the final base migration before B1`};
    case "ledger-gap":return {sql:`delete from supabase_migrations.schema_migrations where version in (${SEALED_BASE_VERSIONS.slice(10,14).map(v=>`'${v}'`).join(",")})`,
      message:prefix+`the migration ledger does not record exactly the 22 base migrations before B1; missing ${SEALED_BASE_VERSIONS.slice(10,14).join(", ")}`};
    case "ledger-extra":return {sql:"insert into supabase_migrations.schema_migrations(version) values ('20250101000000')",
      message:prefix+"the migration ledger does not record exactly the 22 base migrations before B1; unexpected 20250101000000"};
    case "ledger-b1-recorded":return {sql:"insert into supabase_migrations.schema_migrations(version) values ('20261002090000')",
      message:prefix+"B1 is already applied to this database; a baseline must be taken before B1"};
    case "stamp-missing":return {sql:"alter function kernel_private.stamp_binding_provenance() rename to fixture_hidden_stamp",
      message:prefix+"kernel_private.stamp_binding_provenance() does not exist"};
  }
}
export const HookSchema=z.strictObject({id:z.enum(LEDGER_EFFECTS),point:z.literal("S2"),effect:z.enum(LEDGER_EFFECTS),negativeFixture:z.literal(true),
  expected:z.strictObject({stage:z.literal("S3"),message:z.string(),b1EngineInvoked:z.literal(false)})}).superRefine((hook,ctx)=>{
    if(hook.id!==hook.effect || hook.expected.message!==ledgerHook(hook.effect).message)
      ctx.addIssue({code:"custom",message:"hook identity or expected refusal differs"});
  });
export const RegistrySchema=z.strictObject({kind:z.literal("kerneljson:b1-runner-hook-registry/v1"),
  setupProfiles:z.array(z.strictObject({id:z.enum(["none","pinned-helper","platform-definer-fixture"]),sql:z.string().nullable(),sha256:HASH.nullable()})),
  hooks:z.array(HookSchema),regressionSuites:z.array(z.never())}).superRefine((registry,ctx)=>{
    if(JSON.stringify(registry.hooks.map(h=>h.id).sort())!==JSON.stringify([...LEDGER_EFFECTS].sort()))
      ctx.addIssue({code:"custom",message:"closed hook set differs"});
  });
