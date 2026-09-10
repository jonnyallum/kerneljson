# Phase 13: Mission Control

`apps/mission-control/src/server.ts` exports an HTTP handler factory requiring a
trusted authenticator, a `MissionControlStore` and the exact browser origin.
Mount it behind your authenticated gateway. Credentials remain server-side.
There is no permissive production authentication default.

The overview shows the latest 50 tenant tasks; detail pages show outcomes,
up to 100 evidence records and the latest 200 events. Counts describe the visible
recent tasks, not global totals. Text is escaped and pages prohibit scripts.
Refresh reads current state. This initial surface does not include historical
pagination, live streaming or an agent roster.

For controls, inject `createRestateControls(ingress, credentialsFor)` from
`apps/gateway/src/index.ts`. The credential resolver must return credentials for
the authenticated human context. Approve/Deny are shown only to the named human;
Cancel is shown to the task owner while an approval is pending. Same-origin POST
checks precede forwarding to GoldenTaskWorkflowV1, which rechecks authority.
No UI action writes task states directly.

For a local synthetic read-only preview:

```powershell
$env:KERNELJSON_DOCKER_WSL='Ubuntu'
node --import tsx tests/support/mission-preview.ts
```

Visit `http://127.0.0.1:19090`; type `stop` in the preview terminal to close and
remove its disposable database. This test helper must never be deployed.

Validation: five HTTP/tenant/security tests passed, and two targeted real Restate
approval/cancellation integration tests passed (20 unrelated recovery tests not
selected). TypeScript/build passed. Browser inspection verified overview layout,
task detail, and evidence disclosure. Reports: `phase13-http-tests.json` and
`phase13-recovery-tests.json` under `artifacts/local`. No remote hosting occurred.
