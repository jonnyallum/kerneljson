import { readFileSync } from 'node:fs';
const baseline = JSON.parse(readFileSync('tests/baseline.json'));
const report = JSON.parse(readFileSync(process.argv[2] ?? 'artifacts/local/tests.json'));
const tests = report.testResults.flatMap(s => s.assertionResults.map(a => ({file:s.name.replaceAll('\\','/').split('/tests/')[1],name:a.fullName,status:a.status})));
const missing = baseline.tests.filter(b => !tests.some(t => t.file === b.file && t.name === b.name && t.status === 'passed'));
if (!report.success || report.numFailedTests || report.numPendingTests || missing.length || tests.filter(t=>t.file==='recovery.test.ts'&&t.status==='passed').length<27) {
 console.error(JSON.stringify({baselineFailures:missing,total:report.numTotalTests,failed:report.numFailedTests,skipped:report.numPendingTests})); process.exit(1);
}
console.log(`Baseline retained: ${baseline.tests.length}/224; recovery >=27; total ${report.numTotalTests}`);
