import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertBaseEnvironment, assertBaseTarget } from "../../scripts/b1/base-guard.mjs";
import { DATABASE, compose, holdRuntime, migrate, until } from "./local.js";
import { installBaseDatabaseFactory } from "./database.js";

/** Installed only by the base harness, outside every runner stage. */
installBaseDatabaseFactory(async(name:string)=>{
  assertBaseEnvironment();
  if(!/^kj_[a-z0-9_]+$/.test(name)) throw Error("BASE_REFUSED: invalid test database name");
  const release=holdRuntime(),admin=new pg.Pool({connectionString:DATABASE,max:1});
  const database=`${name}_${randomUUID().replaceAll("-","").slice(0,12)}`;
  let created=false,pool:pg.Pool|undefined;
  const close=async()=>{
    await pool?.end();
    try{
      if(created){
        await until(()=>admin.query<{n:number}>("select count(*)::int as n from pg_stat_activity where datname=$1",[database]),r=>r.rows[0]!.n===0,15000);
        await admin.query(`drop database ${database}`);
      }
    }
    finally{await admin.end();release();}
  };
  try{
    compose("up","-d","db");await until(()=>admin.query("select 1"),r=>r.rowCount===1);
    await assertBaseTarget(admin);await admin.query(`create database ${database}`);created=true;
    const url=DATABASE.replace(/\/kerneljson$/,`/${database}`);pool=new pg.Pool({connectionString:url,max:4});
    await migrate(pool);
    return {pool,url,close};
  }catch(error){await close();throw error;}
});
