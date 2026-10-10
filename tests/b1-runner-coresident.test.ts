import { describe, it } from "vitest";
import { CASE_TIMEOUT, expectFixturePassed, runCase } from "./support/b1-runner.js";
import type { Profile } from "../scripts/b1/hooks.js";

/**
 * ADR-0023 27.12.9 co-resident cases, through the governed runner on runner-created clusters of the pinned image
 * (lane C). Drift introduced after the snapshot is shown at both layers (revision 2.7.4): alone, the gate's
 * pre-application inventory equality refuses before the engine runs; with the registered gate-inventory-skip hook,
 * B1 itself aborts 23514 naming the rule. Every expectation is the hook's registered structured expectation, and the
 * record is re-validated by this file as an independent consumer.
 */
const t=(label:string,profile:Profile,hooks:string[])=>
  it.concurrent(label,async()=>{expectFixturePassed(await runCase(label,profile,hooks));},CASE_TIMEOUT);

describe.concurrent("27.12.9 before the snapshot",()=>{
  t("case 18 CRLF helper body: semantic equality, forensic difference","pinned-helper",["helper-crlf"]);
  t("case 14 copy in extensions before the snapshot","pinned-helper",["helper-copy-extensions"]);
  t("ACL-C unpinned event-trigger function before the snapshot, empty","none",["unpinned-event-trigger-before"]);
  t("ACL-C unpinned event-trigger function before the snapshot, helper","pinned-helper",["unpinned-event-trigger-before"]);
});
describe.concurrent("27.12.9 drift after the snapshot, gate layer",()=>{
  t("case 2 one byte, gate","pinned-helper",["drift-helper-body-byte"]);
  t("case 2 upstream body, gate","pinned-helper",["drift-helper-body-upstream"]);
  t("case 3 owner, gate","pinned-helper",["drift-helper-owner"]);
  t("case 4 invoker, gate","pinned-helper",["drift-helper-invoker"]);
  t("case 5 reset search_path, gate","pinned-helper",["drift-helper-config-reset"]);
  t("case 5 public search_path, gate","pinned-helper",["drift-helper-config-public"]);
  t("case 6 revoke PUBLIC, gate","pinned-helper",["drift-helper-acl-revoke-public"]);
  t("case 6 grant kj_worker, gate","pinned-helper",["drift-helper-acl-grant-worker"]);
  t("case 7 ensure_rls dropped, gate","pinned-helper",["drift-ensure-rls-dropped"]);
  t("case 8 disabled, gate","pinned-helper",["drift-ensure-rls-disabled"]);
  t("case 8 replica, gate","pinned-helper",["drift-ensure-rls-replica"]);
  t("case 8 always, gate","pinned-helper",["drift-ensure-rls-always"]);
  t("case 9 one tag, gate","pinned-helper",["drift-tags-create-table-only"]);
  t("case 9 extra tag, gate","pinned-helper",["drift-tags-alter-table-added"]);
  t("case 10 rebound in public, gate","pinned-helper",["drift-ensure-rls-rebound-public"]);
  t("case 10 rebound in extensions, gate","pinned-helper",["drift-ensure-rls-rebound-extensions"]);
  t("case 11 second event trigger, gate","pinned-helper",["drift-second-event-trigger"]);
  t("case 12 definer copy, gate","pinned-helper",["drift-definer-copy-public"]);
  t("case 12 invoker event-trigger function, gate","pinned-helper",["drift-invoker-event-trigger-public"]);
  t("case 13 overload, gate","pinned-helper",["drift-overload-text"]);
  t("case 14 copy in extensions, gate","pinned-helper",["drift-copy-extensions"]);
  t("case 14 set schema, gate","pinned-helper",["drift-set-schema-extensions"]);
  t("case 15 extra definer in kernel_private, gate","none",["drift-extra-definer-kernel-private"]);
  t("case 15 extra definer in public, gate","none",["drift-extra-definer-public"]);
  t("EPH-8 extra definer in extensions, gate","none",["drift-extra-definer-extensions"]);
});
describe.concurrent("27.12.9 drift after the snapshot, pre-COMMIT layer",()=>{
  t("case 2 one byte, P2","pinned-helper",["drift-helper-body-byte","gate-inventory-skip"]);
  t("case 2 upstream body, P2","pinned-helper",["drift-helper-body-upstream","gate-inventory-skip"]);
  t("case 3 owner, P2","pinned-helper",["drift-helper-owner","gate-inventory-skip"]);
  t("case 4 invoker, P2","pinned-helper",["drift-helper-invoker","gate-inventory-skip"]);
  t("case 5 reset search_path, P2","pinned-helper",["drift-helper-config-reset","gate-inventory-skip"]);
  t("case 5 public search_path, P2","pinned-helper",["drift-helper-config-public","gate-inventory-skip"]);
  t("case 6 revoke PUBLIC, P2","pinned-helper",["drift-helper-acl-revoke-public","gate-inventory-skip"]);
  t("case 6 grant kj_worker, P2","pinned-helper",["drift-helper-acl-grant-worker","gate-inventory-skip"]);
  t("case 7 ensure_rls dropped, P2 (c)","pinned-helper",["drift-ensure-rls-dropped","gate-inventory-skip"]);
  t("case 8 disabled, P2","pinned-helper",["drift-ensure-rls-disabled","gate-inventory-skip"]);
  t("case 8 replica, P2","pinned-helper",["drift-ensure-rls-replica","gate-inventory-skip"]);
  t("case 8 always, P2","pinned-helper",["drift-ensure-rls-always","gate-inventory-skip"]);
  t("case 9 one tag, P2","pinned-helper",["drift-tags-create-table-only","gate-inventory-skip"]);
  t("case 9 extra tag, P2","pinned-helper",["drift-tags-alter-table-added","gate-inventory-skip"]);
  t("case 10 rebound in public, P2 (c) among others","pinned-helper",["drift-ensure-rls-rebound-public","gate-inventory-skip"]);
  t("case 10 rebound in extensions, P2 (c)","pinned-helper",["drift-ensure-rls-rebound-extensions","gate-inventory-skip"]);
  t("case 11 second event trigger, E2","pinned-helper",["drift-second-event-trigger","gate-inventory-skip"]);
  t("case 12 and ACL-C definer copy, P1 and P2 (a)","pinned-helper",["drift-definer-copy-public","gate-inventory-skip"]);
  t("case 12 and ACL-C invoker event-trigger function, P2 (a)","pinned-helper",["drift-invoker-event-trigger-public","gate-inventory-skip"]);
  t("case 13 overload, P2 (d)","pinned-helper",["drift-overload-text","gate-inventory-skip"]);
  t("case 14 copy in extensions, P2 (d)","pinned-helper",["drift-copy-extensions","gate-inventory-skip"]);
  t("case 14 set schema, P2 (d)","pinned-helper",["drift-set-schema-extensions","gate-inventory-skip"]);
  t("case 15 extra definer in kernel_private, P1","none",["drift-extra-definer-kernel-private","gate-inventory-skip"]);
  t("case 15 extra definer in public, P1","none",["drift-extra-definer-public","gate-inventory-skip"]);
  t("EPH-8 extra definer in extensions, B1 commits and S7 fails","none",["drift-extra-definer-extensions","gate-inventory-skip"]);
});
describe.concurrent("27.12.9 artefacts, ACL variants and post-COMMIT change",()=>{
  t("case 17 declared entry edited","pinned-helper",["files-entry-digest"]);
  t("case 17 setSha256 edited","pinned-helper",["files-set-sha"]);
  t("ACL-B frozen per-role blanket revoke aborts by P2 (a)","pinned-helper",["b1-variant-runtime-blanket"]);
  t("case 6 frozen PUBLIC blanket revoke aborts by P2 (a)","pinned-helper",["b1-variant-public-blanket"]);
  t("case 37 live surface changed after COMMIT","pinned-helper",["post-commit-drop-ensure-rls"]);
});
