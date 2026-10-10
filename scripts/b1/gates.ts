/**
 * Gate rules shared by scripts/b1/ci-gate.ts and their failing fixtures (tests/b1-gates.test.ts).
 *
 * G7 (ADR-0023 27.12.15): each mutation suite ran in lane A, its verdict lists exactly the mutations of the script at R
 * (the sealed counts: faculties 5, identity 57, identity-cognition 62), and every one was killed by a test or by the
 * migration's own pre-COMMIT refusal. An apply failure, an inconclusive run or a survivor is never a kill.
 */
export const SEALED_MUTATIONS:Readonly<Record<string,number>>=Object.freeze({"faculties":5,"identity":57,"identity-cognition":62});
export function mutationVerdicts(id:string,text:string):[string,string][]{
  return id==="faculties"?[...text.matchAll(/^(F[0-9]+): detected by ([0-9]+) failed assertions$/gm)].map(m=>[m[1]!,"KILLED"]):
    [...text.matchAll(/^([A-Z][0-9]+) (KILLED-PRECOMMIT|KILLED|SURVIVED|INCONCLUSIVE|CANNOT APPLY)\b/gm)].map(m=>[m[1]!,m[2]!]);
}
export function mutationVerdictProblems(id:string,text:string):string[]{
  const sealed=SEALED_MUTATIONS[id];
  if(sealed===undefined) return [`${id}: not a registered mutation suite`];
  const verdicts=mutationVerdicts(id,text),ids=new Set(verdicts.map(v=>v[0])),problems:string[]=[];
  if(ids.size!==sealed || verdicts.length!==sealed) problems.push(`${id}: ${ids.size} mutation verdicts, sealed ${sealed}`);
  const bad=verdicts.filter(v=>!["KILLED","KILLED-PRECOMMIT"].includes(v[1]));
  if(bad.length) problems.push(`${id}: not killed: ${bad.map(v=>v.join(" ")).join(", ")}`);
  if(id!=="faculties" && !/^ALL MUTATIONS KILLED$/m.test(text)) problems.push(`${id}: no ALL MUTATIONS KILLED line`);
  if(/CANNOT APPLY|BASELINE FAILED/.test(text)) problems.push(`${id}: a mutation could not apply or the baseline failed`);
  return problems;
}
