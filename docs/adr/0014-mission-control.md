# ADR-0014: Task-centred Mission Control

Status: ACCEPTED

Mission Control is a server-rendered task view, not an agent roster. Its queries
recheck authenticated tenant membership and expose bounded task, outcome, evidence
and event projections. It never writes task states directly.

Optional approval and cancellation controls call an injected trusted control port
connected to the policy workflow. The server checks the named approver or task
owner, while the workflow remains the authoritative decision boundary. POSTs
require a configured same-origin value and strict bounded form fields. All text
is escaped and a restrictive content-security policy prohibits scripts.

Authentication is an injected deployment responsibility; no permissive production
default or committed token is supplied. A loopback-only synthetic preview exists
for local visual validation. No remote hosting is performed.
