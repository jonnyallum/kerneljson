# ADR-0013: Versioned executable golden evaluations

Status: ACCEPTED

Evaluation executes a deployment-owned candidate against an explicit versioned
golden corpus. Reports bind the suite digest, candidate artifact digest, each
expected/actual result digest, and execution errors. Promotion requires every
case from the exact current suite to pass for the exact candidate digest.
An error cannot be converted into a passing score. Reports are data, not authority
to deploy, change policy or self-modify.

The evaluation store runs its configured candidate itself, anchors its report to
verified task evidence and stores an immutable idempotent report. It does not
accept externally asserted evaluation results. Candidates are bounded, trusted
pure application functions; this is not an untrusted-code sandbox. Runtime code
changes require a new candidate artifact digest. No deployment is automated.
