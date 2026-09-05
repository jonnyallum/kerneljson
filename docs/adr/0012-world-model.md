# ADR-0012: Temporal, evidenced world observations

Status: ACCEPTED

Entities have stable tenant-scoped identity keys and immutable types. The initial
world model records TASK_RESULT observations derived from verified Outcomes.
Observation time records when the source result existed; validity is an explicit
interval. Queries return all observations known and valid at the requested time,
including conflicting observations, rather than silently promoting one to truth.
Confidence 1 describes verification of this task result, not universal certainty.

The initial typed relationship is SHARES_VERIFIED_RESULT. Both endpoints must
have observations backed by the same task/evidence. Relationships retain those
references and all writes recheck tenant membership. The SQL migration protects
entities, observations and relationships from mutation and adds relationship
provenance constraints. Legacy rows without provenance are excluded from reads.
No inferred identities, model-generated facts or autonomous observation are added.
