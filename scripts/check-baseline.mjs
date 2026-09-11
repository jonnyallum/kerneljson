import { readFileSync } from 'node:fs';
const baseline = JSON.parse(readFileSync('tests/baseline.json'));
const report = JSON.parse(readFileSync(process.argv[2] ?? 'artifacts/local/tests.json'));
const tests = report.testResults.flatMap(s => s.assertionResults.map(a => ({file:s.name.replaceAll('\\','/').split('/tests/')[1],name:a.fullName,status:a.status})));
const key = t => `${t.file}\u0000${t.name}`;
// Old qualification, unchanged: every one of the 224 protected baseline tests must still PASS.
// A baseline test that is skipped is not 'passed', so it surfaces here as a regression.
const missing = baseline.tests.filter(b => !tests.some(t => t.file === b.file && t.name === b.name && t.status === 'passed'));
// Skips are permitted ONLY for the enumerated, environment-gated integration tests
// (the S1 Postgres/fencing suites, which run and pass when KJ_TEST_PG_URL points at a
// local throwaway Postgres and skip cleanly otherwise; see tests/baseline.json intentionalSkips).
// Any other skipped test is a silently-disabled test and fails the gate exactly as before.
const allowedSkip = new Set((baseline.intentionalSkips ?? []).map(key));
const unexpectedSkips = tests.filter(t => t.status !== 'passed' && t.status !== 'failed' && !allowedSkip.has(key(t)));
// An intentional-skip entry that has vanished from the report entirely = erased coverage, not additive.
const vanishedSkips = (baseline.intentionalSkips ?? []).filter(s => !tests.some(t => t.file === s.file && t.name === s.name));
const recoveryPassed = tests.filter(t => t.file === 'recovery.test.ts' && t.status === 'passed').length;
if (!report.success || report.numFailedTests || missing.length || unexpectedSkips.length || vanishedSkips.length || recoveryPassed < 27) {
 console.error(JSON.stringify({baselineFailures:missing,unexpectedSkips,vanishedSkips,total:report.numTotalTests,failed:report.numFailedTests,skipped:report.numPendingTests,recoveryPassed})); process.exit(1);
}
console.log(`Baseline retained: ${baseline.tests.length}/224 passing; recovery ${recoveryPassed}>=27; intentional env-gated skips ${allowedSkip.size}; total ${report.numTotalTests}`);
