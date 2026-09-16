import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { evaluateReleaseParity, evaluateAuthority } from '../../../../services/kernel/src/health/evaluate.ts';
import { loadHealthExpectations } from '../../../../services/kernel/src/health/config.ts';
import { reduceCheck } from '../../../../services/kernel/src/alerting/reducer.ts';

const evidence = JSON.parse(readFileSync(new URL('./production.json', import.meta.url), 'utf8'));
const target = 'd5abf22ec176d16932af5cfcd77a8ce3098027bc';
const current = evidence.containers[0].release;
const exp = loadHealthExpectations({ EXPECTED_RELEASE_ID: target });
function parity(running, expected, rejected = evidence.database.boundReleaseRejectionSeen) {
  return evaluateReleaseParity({ dbReachable: true, selfReportedReleaseId: running,
    recentBindingReleaseIds: evidence.database.recentBindings.map(b => b.release_id),
    boundReleaseRejectionSeen: rejected }, { ...exp, releaseId: expected }, evidence.at);
}
const get = (domain, id) => domain.checks.find(c => c.id === id);
const id = 'releaseParity.recentBindingsConsistent';
const baseline = get(parity(current, current), id);
const forecast = get(parity(target, target), id);
const decision = reduceCheck(null, forecast, exp.scheduleId, evidence.at).decision;
assert.equal(baseline.status, 'HEALTHY');
assert.equal(forecast.status, 'CRITICAL');
assert.equal(decision.severity, 'P1');
assert.equal(decision.notify, true);
assert.equal(get(parity(current, target), 'releaseParity.matchesExpected').status, 'CRITICAL');
assert.equal(get(parity(target, target, true), 'releaseParity.noBoundReleaseRejection').status, 'CRITICAL');
const authority = evaluateAuthority({ dbReachable: true,
  recentBindings: [current, target].map((releaseId, i) => ({ taskId: `local-fixture-${i}`, releaseId, createdAt: evidence.at })),
  admittedFireTaskIdsMissingFromTasks: [], boundReleaseRejectionSeen: false,
}, evidence.at);
assert.equal(get(authority, 'authority.bindingReleaseConsistent').status, 'DEGRADED');
console.log(JSON.stringify({ assertionsPassed: 7, baseline, forecast, decision,
  authorityMixedReleaseStatus: get(authority, 'authority.bindingReleaseConsistent').status,
  correctedModel: 'NOT IMPLEMENTED: no trustworthy cutover authority',
  productionMutation: false }, null, 2));
