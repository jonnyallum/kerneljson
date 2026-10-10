import type { RuntimeRole } from "../../services/kernel/src/database/runtime-roles.js";

/**
 * ADR-0023 27.12.15 case CON-48, positive fixture: denied statements whose exact text the log extraction and the trace
 * must reconcile. `name` is the expanded report name of the test in tests/runtime-roles-log-fixture.integration.test.ts
 * that issues `statements` (one 42501 each) on a genuine kj_worker login session. The fixture function
 * public.kj_log_fixture_peek() is created and dropped by that test's owner in its own plan database.
 */
const DENIED="select rolpassword from pg_catalog.pg_authid";
export const LOG_PEEK="select public.kj_log_fixture_peek()";
export const LOG_PREPARED={name:"kj_log_fixture_prepared",text:`${DENIED} where rolname = $1`};
export const LOG_FIXTURE:readonly {name:string;role:RuntimeRole;statements:string[]}[]=[
  {name:"CON-48 log fixture the same denied statement from a first test",role:"kj_worker",statements:[`${DENIED} limit 1`]},
  {name:"CON-48 log fixture the same denied statement from a second test",role:"kj_worker",statements:[`${DENIED} limit 1`]},
  {name:"CON-48 log fixture a multiline statement with a TAB and two spaces inside a literal",role:"kj_worker",
    statements:[`${DENIED}\n\twhere rolname = 'kj  log\tfixture'\n  limit 1`]},
  {name:"CON-48 log fixture a denied function call writes CONTEXT before STATEMENT",role:"kj_worker",statements:[LOG_PEEK]},
  {name:"CON-48 log fixture a named prepared statement executed twice",role:"kj_worker",statements:[LOG_PREPARED.text,LOG_PREPARED.text]},
  {name:"CON-48 log fixture a parameterised statement",role:"kj_worker",statements:[`${DENIED} where rolname = $1 and rolcanlogin = $2`]},
  {name:"CON-48 log fixture a statement longer than 600 characters",role:"kj_worker",
    statements:[`${DENIED} /* ${"padding ".repeat(90)}*/ limit 1`]},
  {name:"CON-48 log fixture two statements differing only by whitespace inside a literal",role:"kj_worker",
    statements:[`${DENIED} where rolname = 'x  y'`,`${DENIED} where rolname = 'x y'`]},
];
