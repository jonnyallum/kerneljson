# ADR-0015: Bounded measured capability routing

Status: ACCEPTED

Routing is deterministic kernel code. Deployment configuration names compatible
capability versions and the default; the registry, evaluation gate and policy
must all accept a candidate before measurements can rank it. Approval-required
decisions are not silently converted to ALLOW. The initial automatic router only
handles ALLOW routes; approval recipes retain their explicit workflow gate.

Recent immutable task/run evidence supplies task success and elapsed execution
measurements. Cost is one execution unit per pure deterministic call, not a
currency estimate. Selection enforces configured sample, freshness, reliability,
latency and cost limits. Cold start is an explicit opt-in for the default only.
Stable tie-breaking and a journaled snapshot keep replay from changing the route.

The registry currently has one uppercase implementation. Multiple compatible
versions are exercised in fixtures; registering production alternatives still
requires reviewed code and evaluation. This introduces no persistent workers,
agent roster, speculative providers or model-controlled permissions.
