# Phase 14: Adaptive execution routing

`AdaptiveRouter` takes deployment-owned compatible versions, limits, policy rules
and an evaluation gate. It only ranks registered, evaluated, policy-ALLOW routes.
Approval-required work stays in the explicit approval workflow. Measurements
cannot grant permissions or register capabilities.

`readRouteObservations` reads tenant-scoped immutable run/outcome/event evidence.
Latency is elapsed task execution time; success is verified task completion.
Cost is one execution unit per deterministic call, not currency or provider billing.
The router enforces sample/freshness/reliability/latency/cost limits, ranks success
then cost then latency, and breaks ties by capability/version. Cold start requires
explicit opt-in and only selects the evaluated default. Zero samples remain labelled
COLD_START; they are not claimed measurements.

`routeDurably` journals the snapshot/selection, then records it through an
idempotent sink. The caller persists the selected step/policy before using the
existing capability execution/receipt helper. Production workflows keep their
existing versioned journals. Only one uppercase implementation is registered;
multi-version routing is tested with compatible test implementations.

Validation: six routing tests passed and two targeted real recovery tests passed
(21 unrelated cases not selected), including route audit commit/acknowledgement
failure and measurement extraction from a completed golden task. TypeScript and
build passed. Reports: `phase14-unit-tests.json`, `phase14-recovery-tests.json`.
