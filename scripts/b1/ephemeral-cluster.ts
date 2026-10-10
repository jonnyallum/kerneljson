import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

export const LIVE_IDENTITY_SQL=`select current_setting('cluster_name') as cluster,
  (select system_identifier::text from pg_catalog.pg_control_system()) as sid,
  extract(epoch from pg_postmaster_start_time())::double precision as started,version() as version,
  (select rolsuper from pg_roles where rolname=current_user) as superuser,current_database() as database`;
export interface LiveIdentity {cluster:string;sid:string;started:number;version:string;superuser:boolean;database:string}
export type LifecycleEvent={step:"L2"|"L3"|"L4"|"L5"|"L6";outcome:"passed"|"refused"|"skipped";details:unknown};
/** Images used only by the registered L2-target fixtures; pinned by digest like the cluster image. */
export const FIXTURE_IMAGES={forwarder:"alpine/socat@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e"} as const;
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
export type TargetFixture="foreign-container"|"preexisting-tunnel";

/**
 * The runner's one connection factory. Only the ephemeral entry point constructs it. Every connection it returns has
 * passed L3 (unless the registered L3-skip hook omitted it for exactly that connection) and, unconditionally, L5:
 * there is no branch around L5. Hooks receive its clients, never an address, a credential or the engine.
 */
export class EphemeralCluster {
  containerId="";networkId="";created="";
  /** The run's own container: what L6 removes, even when a registered fixture substituted the factory's target. */
  genuineContainerId="";
  private port=0;
  private skipNextAttestation=false;
  /** The identity L5 read on the most recent connection; S4 compares the run files with it. */
  lastIdentity:LiveIdentity|null=null;
  readonly fixtures:{kind:"container"|"network";id:string;removed:boolean}[]=[];
  constructor(readonly runId:string,readonly nonce:string,readonly image:string,readonly serverVersion:string,
    readonly databases:readonly string[],readonly hostedIds:readonly string[],private record:(event:LifecycleEvent)=>void){}
  private docker(args:string[]):string{
    const r=spawnSync("docker",args,{encoding:"utf8",timeout:120000,windowsHide:true,maxBuffer:16*1024*1024});
    if(r.status!==0 || r.error) throw Error(`LIFECYCLE_REFUSED: docker ${args[0]} ${args[1] ?? ""} failed: ${(r.stderr ?? "").trim().slice(0,300)}`);
    return r.stdout.trim();
  }
  private async ready(id:string):Promise<void>{
    for(let i=0;i<240;i++){
      const r=spawnSync("docker",["logs",id],{encoding:"utf8",timeout:10000,windowsHide:true});
      const logs=r.stdout+r.stderr;
      // A fresh pinned image starts a temporary initdb server and then the final server.
      if(r.status===0 && logs.includes("PostgreSQL init process complete; ready for start up.") &&
        (logs.match(/database system is ready to accept connections/g) ?? []).length>=2) return;
      await delay(250);
    }
    throw Error("LIFECYCLE_REFUSED: database readiness timeout");
  }
  private hostPort(id:string):number{
    const ports=JSON.parse(this.docker(["inspect",id]))[0].NetworkSettings.Ports;
    const binding=Object.values(ports as Record<string,{HostIp:string;HostPort:string}[]|null>).flat().find(Boolean);
    const port=Number(binding?.HostPort);
    if(!Number.isInteger(port) || port<1) throw Error("LIFECYCLE_REFUSED: fixture port unreadable");
    return port;
  }
  /** L2, and for a registered L2-target hook the substitution of the factory's container and port. */
  async create(target?:TargetFixture):Promise<{substituted:{fixture:TargetFixture;containerId:string;port:number}|null}>{
    try{
      if(process.env.DOCKER_HOST) throw Error("LIFECYCLE_REFUSED: remote Docker selector forbidden");
      const contexts=JSON.parse(this.docker(["context","inspect"]));
      if(contexts.length!==1 || !/^(npipe:\/\/|unix:\/\/)/.test(contexts[0].Endpoints.docker.Host)) throw Error("LIFECYCLE_REFUSED: local Docker daemon required");
      let backend="";
      if(target==="preexisting-tunnel"){
        // The forwarded cluster exists before the run's container: it is the shape of a tunnel to a pre-existing database.
        const net=this.docker(["network","create","--label",`kj.b1.fixture.run=${this.runId}`,`kj-fixture-${this.runId}`]);
        this.fixtures.push({kind:"network",id:net,removed:false});
        backend=this.docker(["run","-d","--network",net,"--network-alias","kj-fixture-backend","--label",`kj.b1.fixture.run=${this.runId}`,
          "--tmpfs","/var/lib/postgresql/data:rw","-e","POSTGRES_HOST_AUTH_METHOD=trust",this.image]);
        this.fixtures.push({kind:"container",id:backend,removed:false});
        await this.ready(backend);
        await delay(1500);
      }
      this.networkId=this.docker(["network","create","--label",`kj.b1.ephemeral.run=${this.runId}`,`kj-eph-${this.runId}`]);
      this.containerId=this.docker(["run","-d","--name",`kj-eph-${this.runId}`,"--network",this.networkId,"--network-alias","kj-eph-db",
        "--label",`kj.b1.ephemeral.run=${this.runId}`,"--tmpfs","/var/lib/postgresql/data:rw","-e","POSTGRES_HOST_AUTH_METHOD=trust",
        "-p","127.0.0.1::5432",this.image,"postgres","-c",`cluster_name=kj-eph-${this.nonce}`]);
      this.genuineContainerId=this.containerId;
      if(!/^[0-9a-f]{64}$/.test(this.containerId) || !/^[0-9a-f]{64}$/.test(this.networkId)) throw Error("LIFECYCLE_REFUSED: daemon IDs malformed");
      this.created=JSON.parse(this.docker(["inspect",this.containerId]))[0].Created;
      this.record({step:"L2",outcome:"passed",details:{containerId:this.containerId,networkId:this.networkId,created:this.created}});
      await this.ready(this.containerId);
      let substituted:{fixture:TargetFixture;containerId:string;port:number}|null=null;
      if(target==="foreign-container"){
        const foreign=this.docker(["run","-d","--label",`kj.b1.fixture.run=${this.runId}`,"--tmpfs","/var/lib/postgresql/data:rw",
          "-e","POSTGRES_HOST_AUTH_METHOD=trust","-p","127.0.0.1::5432",this.image]);
        this.fixtures.push({kind:"container",id:foreign,removed:false});
        await this.ready(foreign);
        substituted={fixture:target,containerId:foreign,port:this.hostPort(foreign)};
      }
      if(target==="preexisting-tunnel"){
        const net=this.fixtures.find(f=>f.kind==="network")!.id;
        const forwarder=this.docker(["run","-d","--network",net,"--label",`kj.b1.fixture.run=${this.runId}`,"-p","127.0.0.1::5432",
          FIXTURE_IMAGES.forwarder,"TCP-LISTEN:5432,fork,reuseaddr","TCP:kj-fixture-backend:5432"]);
        this.fixtures.push({kind:"container",id:forwarder,removed:false});
        await delay(1500);
        substituted={fixture:target,containerId:forwarder,port:this.hostPort(forwarder)};
      }
      if(substituted){this.containerId=substituted.containerId;this.port=substituted.port;}
      else this.attest();
      return {substituted};
    }catch(error){this.record({step:"L2",outcome:"refused",details:String(error)});throw error;}
  }
  /** Registered hook L3-skip: the attestation is omitted for the next connection only; L5 still runs. */
  skipAttestationOnce():void{this.skipNextAttestation=true;}
  attest():void{
    try{
      const inspections=JSON.parse(this.docker(["inspect",this.containerId]));
      if(inspections.length!==1) throw Error("ambiguous container");
      const c=inspections[0];
      if(!c.State.Running || c.State.Paused || c.Config.Image!==this.image || c.Config.Labels?.["kj.b1.ephemeral.run"]!==this.runId ||
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
      if(networks.length!==1 || networks[0].Name!==`kj-eph-${this.runId}` || networks[0].Labels?.["kj.b1.ephemeral.run"]!==this.runId ||
        !equal(Object.keys(networks[0].Containers),[this.containerId])) throw Error("network membership differs");
      if(c.Created!==this.created) throw Error("container creation time differs from L2");
      this.record({step:"L3",outcome:"passed",details:{containerId:this.containerId,created:this.created,port:this.port,networkId:this.networkId}});
    }catch(error){
      const message=String(error instanceof Error?error.message:error).replace(/^LIFECYCLE_REFUSED: /,"");
      this.record({step:"L3",outcome:"refused",details:message});throw Error(`LIFECYCLE_REFUSED: L3: ${message}`);
    }
  }
  async connect(database:string):Promise<pg.Client>{
    if(this.skipNextAttestation){
      this.skipNextAttestation=false;
      this.record({step:"L3",outcome:"skipped",details:{hook:"l3-skip",containerId:this.containerId}});
    } else this.attest();
    if(database!=="postgres" && !this.databases.includes(database)) throw Error("L4: unplanned database");
    const client=new pg.Client({host:"127.0.0.1",port:this.port,user:"postgres",database,password:"",ssl:false,
      application_name:"kj-b1-runner",connectionTimeoutMillis:10000,options:"",statement_timeout:60000});
    try{
      await client.connect();this.record({step:"L4",outcome:"passed",details:{database,host:"127.0.0.1",port:this.port,user:"postgres"}});
      const live=(await client.query<LiveIdentity>(LIVE_IDENTITY_SQL)).rows[0];
      if(!live) throw Error("L5: identity row missing");
      const problems=identityProblems(live,this.created,this.nonce,this.serverVersion,this.hostedIds);
      if(live.database!==database) problems.push("database differs");
      if(problems.length) throw Error(`L5: ${problems.join("; ")}`);
      this.lastIdentity=live;this.record({step:"L5",outcome:"passed",details:live});return client;
    }catch(error){this.record({step:"L5",outcome:"refused",details:String(error instanceof Error?error.message:error)});await client.end().catch(()=>undefined);throw error;}
  }
  async engineTarget(database:string):Promise<string>{
    const client=await this.connect(database);await client.end();
    return `postgresql://postgres@127.0.0.1:${this.port}/${encodeURIComponent(database)}?sslmode=disable`;
  }
  get address():{port:number}{return {port:this.port};}
  /** L6: the run container and network, then any registered fixture containers and networks. */
  teardown():void{
    const removed:{kind:string;id:string}[]=[];
    const genuine=this.genuineContainerId;
    try{
      if(genuine){
        this.docker(["rm","-f",genuine]);
        const result=spawnSync("docker",["inspect",genuine],{encoding:"utf8",timeout:10000,windowsHide:true});
        if(result.status===0 || !/No such (object|container)/i.test(result.stderr)) throw Error("container removal unverified");
        removed.push({kind:"container",id:genuine});
      }
      if(this.networkId){
        this.docker(["network","rm",this.networkId]);
        const result=spawnSync("docker",["network","inspect",this.networkId],{encoding:"utf8",timeout:10000,windowsHide:true});
        if(result.status===0 || !/not found|No such/i.test(result.stderr)) throw Error("network removal unverified");
        removed.push({kind:"network",id:this.networkId});
      }
      for(const kind of ["container","network"] as const) for(const f of this.fixtures.filter(x=>x.kind===kind)){
        this.docker(kind==="container"?["rm","-f",f.id]:["network","rm",f.id]);
        const r=spawnSync("docker",kind==="container"?["inspect",f.id]:["network","inspect",f.id],{encoding:"utf8",timeout:10000,windowsHide:true});
        if(r.status===0) throw Error("fixture removal unverified");
        f.removed=true;removed.push({kind:`fixture-${kind}`,id:f.id});
      }
      this.record({step:"L6",outcome:"passed",details:removed});
    }catch(error){this.record({step:"L6",outcome:"refused",details:{removed,error:String(error)}});throw error;}
  }
}
