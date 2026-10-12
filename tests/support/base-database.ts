import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertBaseEnvironment, assertBaseTarget } from "../../scripts/b1/base-guard.mjs";
import { EngineRefusal, engineVerifier, installHandOutVerification, unprovenUrlProblems } from "../../scripts/b1/verify-engine-image.js";
import { DATABASE, compose, currentTestFile, holdRuntime, migrate, until } from "./local.js";
import { installBaseDatabaseFactory } from "./database.js";

/**
 * Installed only by the base harness, outside every runner stage. KJ-P8 B1 A10.7 2-R4d: after `compose up`, and
 * before assertBaseTarget, create database or migrate, the running container is verified (pinned digest, version,
 * binding, server identity); DATABASE must address that verified binding. Every connection this process hands out, from
 * any pool or client (the factory's, a consumer's pool on database.url or DATABASE, migrate's), is verified again for
 * that hand-out (installHandOutVerification, A10.7 v7 review R2). Any failure throws, so the caller fails closed.
 */
installHandOutVerification(engineVerifier,currentTestFile);
installBaseDatabaseFactory(async(name:string)=>{
  assertBaseEnvironment();
  if(!/^kj_[a-z0-9_]+$/.test(name)) throw Error("BASE_REFUSED: invalid test database name");
  const release=holdRuntime(),verifier=engineVerifier(),file=currentTestFile();
  let admin:pg.Pool|undefined;
  const database=`${name}_${randomUUID().replaceAll("-","").slice(0,12)}`;
  let created=false,pool:pg.Pool|undefined;
  const close=async()=>{
    await pool?.end();
    try{
      if(created){
        await until(()=>admin!.query<{n:number}>("select count(*)::int as n from pg_stat_activity where datname=$1",[database]),r=>r.rows[0]!.n===0,15000);
        await admin!.query(`drop database ${database}`);
      }
    }
    finally{await admin?.end();release();}
  };
  try{
    compose("up","-d","db");
    const verified=await verifier.attempt(file,async()=>{await until(async()=>verifier.ready(),ok=>ok);return verifier.verifyContainer();});
    const constant=new URL(DATABASE),problems=unprovenUrlProblems(process.env,verified);
    if(constant.hostname!==verified.host || Number(constant.port)!==verified.port) problems.push(`DATABASE does not address the verified binding ${verified.binding}`);
    if(problems.length) throw new EngineRefusal("url",problems.join("; "));
    admin=new pg.Pool({connectionString:DATABASE,max:1});
    await assertBaseTarget(admin);await admin.query(`create database ${database}`);created=true;
    const url=DATABASE.replace(/\/kerneljson$/,`/${database}`);pool=new pg.Pool({connectionString:url,max:4});
    await migrate(pool);
    return {name:database,pool,url,close};
  }catch(error){await close();throw error;}
});
