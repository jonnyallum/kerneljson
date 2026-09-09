# Gate 1 permission matrix

Authority = authenticated principal kind + selected tenant + ACTIVE membership + action rule + task-specific scope. Unknown roles/actions deny. A role name supplied in HTTP JSON has no authority.

| Operation | Permitted roles | Additional scope |
| --- | --- | --- |
| Submit task | owner, operator, member | Active membership; admission; reviewed recipe only. |
| Read task/history | owner, operator, member, reviewer, reader | Same tenant. |
| Read evidence/outcome | owner, operator, member, reviewer, reader | Same tenant through task ownership relation. |
| Cancel task | owner, operator, member | Task principal must equal current principal; binding supports cancel. |
| Signal task | owner, operator, member | Task principal must equal current principal; strict supported signal. |
| Approve task | owner, operator, reviewer | HUMAN and exactly named approver, current scope and unexpired approval. |
| Reject approval | owner, operator, reviewer | Same checks as approval. |
| Inspect memory | owner, operator, member, reviewer, reader | Same tenant and active membership. |
| Inspect world model | owner, operator, member, reviewer, reader | Same tenant and active membership. |
| Invoke capability | kernel internal only | Existing deterministic policy and capability verifier; no public invoke endpoint. |
| Create schedules | owner, operator | HUMAN; deployment schedule permission/configuration; bounded template. |
| Disable schedules | owner, operator | Own task cancellation; global disable is deployment administration, not tenant API. |
| Administrative recovery/intervention | infrastructure operator only | Separate trusted admin boundary; no public endpoint or tenant-role bypass. |

Roles authorize available actions, not arbitrary access to another principal's controls. A SERVICE member may perform allowed reads/submissions but never satisfy a HUMAN approval or create a human schedule.

Membership lifecycle: ACTIVE permits matrix checks; REVOKED denies all new authority; REMOVED is a retained tombstone with no authority. Historical tasks and actors stay attributed. Transition timestamps are retained and lifecycle changes audited. Reactivation is an explicit trusted administrative operation, not implicit token refresh. Existing memberships migrate to ACTIVE for compatibility; no users are newly granted roles.

Legacy records without a binding remain readable. A missing binding is not permission to guess GoldenTaskWorkflowV1. Current in-flight execution remains Restate-owned; revocation prevents new public commands, and schedule child authorization remains rechecked by its workflow. No task history is erased on revocation.
