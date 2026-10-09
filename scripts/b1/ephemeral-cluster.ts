import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

export const LIVE_IDENTITY_SQL=`select current_setting('cluster_name') as cluster,
  (select system_identifier::text from pg_catalog.pg_control_system()) as sid,
  extract(epoch from pg_postmaster_start_time())::double precision as started,version() as version,
  (select rolsuper from pg_roles where rolname=current_user) as superuser,current_database() as database`;
export interface LiveIdentity {cluster:string;sid:string;started:number;version:string;superuser:boolean;database:string}
export type LifecycleEvent={step:"L2"|"L3"|"L4"|"L5"|"L6";outcome:"passed"|"refused";details:unknown};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function identityProblems(live:LiveIdentity,created:string,nonce:string,version:string,hostedIds:readonly string[]):string[]{
  const problems:string[]=[];
  if(live.cluster!==`kj-eph-${nonce}`) problems.push("cluster nonce differs");
  if(live.version!==version) problems.push("server version differs");
  if(live.superuser!==true) problems.push("current_user is not superuser");
  if(hostedIds.includes(live.sid)) problems.push("system identifier belongs to hosted artifact");
  const floorCreated=Math.floor(Date.parse(created)/1000);
  if(!Number.isFinite(floorCreated) || !Number.isFinite(live.started) || !/^-?[0-9]+$/.test(live.sid)) problems.push("identity time or identifier unreadable");
  else {
    const initdb=Number(BigInt.asUintN(64,BigInt(live.sid))>>32n);
    if(initdb<floorCreated || initdb>live.started || live.started<floorCreated) problems.push("cluster predates container or initdb follows postmaster start");
  }
  return problems;
}

/** Only the ephemeral entry point constructs this factory. Hooks receive its attested clients, never target URLs. */
export class EphemeralCluster {
  containerId="";networkId="";created="";
  private port=0;
  constructor(readonly runId:string,readonly nonce:string,readonly image:string,readonly serverVersion:string,
    readonly databases:readonly string[],readonly hostedIds:readonly string[],private record:(event:LifecycleEvent)=>void){}
  private docker(args:string[]):string{
    const r=spawnSync("docker",args,{encoding:"utf8",timeout:60000,windowsHide:true,maxBuffer:8*1024*1024});
    if(r.status!==0 || r.error) throw Error(`LIFECYCLE_REFUSED: docker ${args[0]} failed`);
    return r.stdout.trim();
  }
  async create():Promise<void>{
    try{
      if(process.env.DOCKER_HOST) throw Error("remote Docker selector forbidden");
      const contexts=JSON.parse(this.docker(["context","inspect"]));
      if(contexts.length!==1 || !/^(npipe:\/\/|unix:\/\/)/.test(contexts[0].Endpoints.docker.Host)) throw Error("local Docker daemon required");
      this.networkId=this.docker(["network","create","--label",`kj.b1.ephemeral.run=${this.runId}`,`kj-eph-${this.runId}`]);
      this.containerId=this.docker(["run","-d","--name",`kj-eph-${this.runId}`,"--network",this.networkId,"--network-alias","kj-eph-db",
        "--label",`kj.b1.ephemeral.run=${this.runId}`,"--tmpfs","/var/lib/postgresql/data:rw","-e","POSTGRES_HOST_AUTH_METHOD=trust",
        "-p","127.0.0.1::5432",this.image,"postgres","-c",`cluster_name=kj-eph-${this.nonce}`]);
      if(!/^[0-9a-f]{64}$/.test(this.containerId) || !/^[0-9a-f]{64}$/.test(this.networkId)) throw Error("daemon IDs malformed");
      this.record({step:"L2",outcome:"passed",details:{containerId:this.containerId,networkId:this.networkId}});
      this.attest();
      for(let i=0;i<120;i++){
        const ready=spawnSync("docker",["logs",this.containerId],{encoding:"utf8",timeout:5000,windowsHide:true});
        const logs=ready.stdout+ready.stderr;
        // stdout/stderr are separate streams: do not infer ordering by concatenating them.
        // A fresh pinned image starts a temporary initdb server and then the final server.
        if(ready.status===0 && logs.includes("PostgreSQL init process complete; ready for start up.") &&
          (logs.match(/database system is ready to accept connections/g) ?? []).length>=2) return;
        await delay(250);
      }
      throw Error("database readiness timeout");
    }catch(error){this.record({step:"L2",outcome:"refused",details:String(error)});throw error;}
  }
  attest():void{
    try{
      const inspections=JSON.parse(this.docker(["inspect",this.containerId]));
      if(inspections.length!==1) throw Error("ambiguous container");
      const c=inspections[0];
      if(!c.State.Running || c.State.Paused || c.Config.Image!==this.image || c.Config.Labels["kj.b1.ephemeral.run"]!==this.runId ||
        !equal(c.Mounts,[]) || !equal(c.HostConfig.Tmpfs,{"/var/lib/postgresql/data":"rw"}) ||
        !equal(c.Config.Cmd,["postgres","-c",`cluster_name=kj-eph-${this.nonce}`]) || !equal(c.Config.Entrypoint,["docker-entrypoint.sh"]))
        throw Error("container image, command, label, state or mounts differ");
      const ports=c.NetworkSettings.Ports;
      if(!equal(Object.keys(ports),["5432/tcp"]) || ports["5432/tcp"].length!==1 || ports["5432/tcp"][0].HostIp!=="127.0.0.1")
        throw Error("port binding differs");
      const port=Number(ports["5432/tcp"][0].HostPort);
      if(!Number.isInteger(port) || port<1 || port>65535 || (this.port && this.port!==port)) throw Error("port changed or malformed");
      this.port=port;
      if(Object.keys(c.NetworkSettings.Networks).length!==1 || (Object.values(c.NetworkSettings.Networks) as {NetworkID:string}[]).some(n=>n.NetworkID!==this.networkId))
        throw Error("container network differs");
      const networks=JSON.parse(this.docker(["network","inspect",this.networkId]));
      if(networks.length!==1 || networks[0].Name!==`kj-eph-${this.runId}` || networks[0].Labels["kj.b1.ephemeral.run"]!==this.runId ||
        !equal(Object.keys(networks[0].Containers),[this.containerId])) throw Error("network membership differs");
      if(this.created && this.created!==c.Created) throw Error("container creation time changed");
      this.created=c.Created;
      this.record({step:"L3",outcome:"passed",details:{containerId:this.containerId,created:this.created,port:this.port,networkId:this.networkId}});
    }catch(error){this.record({step:"L3",outcome:"refused",details:String(error)});throw error;}
  }
  async connect(database:string):Promise<pg.Client>{
    this.attest();
    if(database!=="postgres" && !this.databases.includes(database)) throw Error("L4: unplanned database");
    const client=new pg.Client({host:"127.0.0.1",port:this.port,user:"postgres",database,password:"",ssl:false,
      application_name:"kj-b1-runner",connectionTimeoutMillis:10000,options:"",statement_timeout:30000});
    try{
      await client.connect();this.record({step:"L4",outcome:"passed",details:{database,host:"127.0.0.1",port:this.port,user:"postgres"}});
      const live=(await client.query<LiveIdentity>(LIVE_IDENTITY_SQL)).rows[0];
      if(!live) throw Error("L5: identity row missing");
      const problems=identityProblems(live,this.created,this.nonce,this.serverVersion,this.hostedIds);
      if(live.database!==database) problems.push("database differs");
      if(problems.length) throw Error(`L5: ${problems.join("; ")}`);
      this.record({step:"L5",outcome:"passed",details:live});return client;
    }catch(error){this.record({step:"L5",outcome:"refused",details:String(error)});await client.end().catch(()=>undefined);throw error;}
  }
  async engineTarget(database:string):Promise<string>{
    const client=await this.connect(database);await client.end();
    return `postgresql://postgres@127.0.0.1:${this.port}/${encodeURIComponent(database)}?sslmode=disable`;
  }
  teardown():void{
    const removed:{kind:string;id:string}[]=[];
    try{
      if(this.containerId){
        this.docker(["rm","-f",this.containerId]);
        const result=spawnSync("docker",["inspect",this.containerId],{encoding:"utf8",timeout:10000,windowsHide:true});
        if(result.status===0 || !/No such (object|container)/i.test(result.stderr)) throw Error("container removal unverified");
        removed.push({kind:"container",id:this.containerId});
      }
      if(this.networkId){
        this.docker(["network","rm",this.networkId]);
        const result=spawnSync("docker",["network","inspect",this.networkId],{encoding:"utf8",timeout:10000,windowsHide:true});
        if(result.status===0 || !/not found|No such/i.test(result.stderr)) throw Error("network removal unverified");
        removed.push({kind:"network",id:this.networkId});
      }
      this.record({step:"L6",outcome:"passed",details:removed});
    }catch(error){this.record({step:"L6",outcome:"refused",details:{removed,error:String(error)}});throw error;}
  }
}
