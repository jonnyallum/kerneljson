# ADR-0016: Opt-in bounded scheduled tasks

Status: ACCEPTED

The initial autonomous workflow repeats an explicitly requested, approved
uppercase template a finite number of times. The schedule is a Task with a
persisted plan and SCHEDULE step; each execution is a child Task with parentTaskId.
Deployment configuration defaults disabled and caps iterations, execution-unit
budget and interval. The model cannot enable or authorize a schedule.

Restate owns durable timers and child calls. Submission requires an authenticated
human and a deployment authorization callback; each next child rechecks current
authorization. A durable cancellation signal stops future children. An in-flight
pure child may finish before cancellation takes effect. There is no polling job
queue, unbounded loop, autonomous planning or external write capability.

A separately named child workflow uses the golden compiler/policy/evidence chain
and verifies its active parent's persisted plan before creating the child. Existing
golden journals retain their default mode. Parent completion independently checks
the expected child identities, parent links and verified Outcomes, then records
its own evidence, Outcome and completion event atomically. Missing/failed child
outcomes can never complete the parent. No production scheduler is registered or
enabled by default, and no remote deployment is included.
