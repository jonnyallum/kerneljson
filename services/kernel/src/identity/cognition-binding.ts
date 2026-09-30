import type pg from "pg";
import {
  IdentityCognitionPin,
  IdentityCognitionState,
  type IdentityCognitionLatch,
  type ModelRequest,
} from "../../../../packages/contracts/src/index.js";
import type { FacultyPin } from "../../../../packages/contracts/src/faculty.js";
import { identityFramingCeiling } from "../faculty/identity-ceiling.js";
import { assemblyDigestOf } from "../mission/cognition-digests.js";
import { canonicalDigest, identityCoreDigestV1 } from "./canonical.js";
import {
  IdentityCognitionRefusal,
  assertProjectionWithinCap,
  countIdentityBlocks,
  profileForOperation,
  projectIdentity,
  projectionDigest,
  renderIdentityBlock,
} from "./projection.js";

/**
 * KJ-P7B-1 (ADR-0022 sections 4 and 8, D1 erratum) - the identity cognition port for the mission analyst.
 *
 * The DATABASE latch row is canonical. What `latch` returns is journaled by Restate as replay material only; before
 * every provider call `authorize` re-reads the database and fails closed if the journal and the database disagree.
 * KJ_IDENTITY_COGNITION_ENABLED is read at most once per analyst step, inside `latch`, and only when no latch row
 * exists - never by replay, retry, authorisation, completion or health. Identity reads the persisted faculty pin
 * it is handed; it never selects, writes or widens it.
 */
export interface MissionIdentityPort {
  latch(input: { tenantId: string; taskId: string; stepId: string; facultyPin: FacultyPin | null }): Promise<IdentityCognitionState>;
  authorize(state: IdentityCognitionState, facultyPin: FacultyPin | null, request: ModelRequest, expectedAssemblyDigest: string): Promise<void>;
}

/** Exactly "true" or "false"; unset or empty is false. Anything else refuses rather than guesses. */
export function parseIdentityCognitionEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`KJ_IDENTITY_COGNITION_ENABLED must be exactly "true" or "false" when set (got ${JSON.stringify(raw)}) - refusing to guess`);
}

type Queryable = Pick<pg.PoolClient, "query">;

type CanonicalRead =
  | { kind: "LEGACY"; state: IdentityCognitionState; latched: boolean }
  | { kind: "CONTRACT"; contractStartEpoch: number; latch: IdentityCognitionLatch | null; pin: IdentityCognitionPin | null };

const contractState = (r: Extract<CanonicalRead, { kind: "CONTRACT" }>): IdentityCognitionState =>
  IdentityCognitionState.parse({ kind: "CONTRACT", contractStartEpoch: r.contractStartEpoch, latch: r.latch, pin: r.pin });

interface SourceRow {
  id: string;
  version: number;
  document: unknown;
  identity_core_digest: string;
  class_a_digest: string;
  core_digest_v1: string;
  class_a_digest_v1: string;
}

const refuse = (code: string): never => {
  throw new IdentityCognitionRefusal(code);
};

/** A deterministic database refusal (class 22/23) becomes a stable refusal code; anything transient propagates. */
function asRefusal(error: unknown): unknown {
  if (error instanceof IdentityCognitionRefusal) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (code.startsWith("23") || code.startsWith("22"))) {
    const message = error instanceof Error ? error.message : "";
    return new IdentityCognitionRefusal(/^[A-Z][A-Z0-9_]{3,60}/.exec(message)?.[0] ?? "IDENTITY_LATCH_REFUSED");
  }
  return error;
}

export class PgIdentityCognition implements MissionIdentityPort {
  constructor(
    private readonly pool: pg.Pool,
    /** Reads KJ_IDENTITY_COGNITION_ENABLED. Called only when a new latch is being created. */
    private readonly readEnabled: () => boolean,
  ) {}

  private async read(db: Queryable, tenantId: string, taskId: string, stepId: string): Promise<CanonicalRead> {
    const binding = (await db.query("select tenant_id, release_epoch from kernel_private.execution_bindings where task_id=$1", [taskId])).rows[0];
    if (binding && binding.tenant_id !== tenantId) refuse("IDENTITY_TENANT_REFUSED");
    const marker = (await db.query("select first_release_epoch from kernel_private.identity_cognition_contract_v1 where singleton")).rows[0];
    const latchRow = (await db.query(
      "select tenant_id, task_id, step_id, mode, release_epoch from kernel_private.identity_cognition_latches where task_id=$1 and step_id=$2",
      [taskId, stepId],
    )).rows[0];
    const pinRow = (await db.query("select tenant_id, pin from public.identity_pins where task_id=$1 and step_id=$2", [taskId, stepId])).rows[0];
    const bindingEpoch = binding ? Number(binding.release_epoch) : null;
    const contractStart = marker ? Number(marker.first_release_epoch) : null;
    if (contractStart === null || bindingEpoch === null || bindingEpoch < contractStart) {
      return { kind: "LEGACY", state: IdentityCognitionState.parse({ kind: "LEGACY", taskId, stepId, releaseEpoch: bindingEpoch }), latched: Boolean(latchRow || pinRow) };
    }
    let pin: IdentityCognitionPin | null = null;
    if (pinRow) {
      pin = IdentityCognitionPin.parse(pinRow.pin);
      if (canonicalDigest(pin) !== canonicalDigest(pinRow.pin) || pinRow.tenant_id !== tenantId) refuse("IDENTITY_PIN_CORRUPT");
    }
    const latch: IdentityCognitionLatch | null = latchRow
      ? { tenantId: latchRow.tenant_id, taskId: latchRow.task_id, stepId: latchRow.step_id, mode: latchRow.mode, releaseEpoch: Number(latchRow.release_epoch) }
      : null;
    return { kind: "CONTRACT", contractStartEpoch: contractStart, latch, pin };
  }

  private async source(db: Queryable, tenantId: string, identityId: string, version: number): Promise<SourceRow | null> {
    const row = (await db.query("select * from kernel_private.identity_cognition_source_v1($1,$2,$3)", [tenantId, identityId, version])).rows[0];
    return row ? (row as SourceRow) : null;
  }

  /** Stored = SQL v1 = TypeScript v1, for both digests, or refused. */
  private static assertParity(src: SourceRow, expected?: { core: string; classA: string }): void {
    const doc = src.document as { sections?: { classA?: unknown } };
    const tsCore = identityCoreDigestV1(src.document);
    const tsClassA = identityCoreDigestV1(doc.sections?.classA);
    const agree = src.identity_core_digest === src.core_digest_v1 && src.core_digest_v1 === tsCore
      && src.class_a_digest === src.class_a_digest_v1 && src.class_a_digest_v1 === tsClassA;
    if (!agree || (expected && (expected.core !== tsCore || expected.classA !== tsClassA))) refuse("IDENTITY_DIGEST_MISMATCH");
  }

  private async buildPin(db: Queryable, input: { tenantId: string; taskId: string; stepId: string }, facultyPin: FacultyPin): Promise<IdentityCognitionPin> {
    const current = (await db.query("select identity_id, version from public.identity_current where tenant_id=$1", [input.tenantId])).rows;
    if (current.length !== 1) refuse("IDENTITY_NOT_ACTIVATED");
    const src = await this.source(db, input.tenantId, current[0].identity_id, current[0].version);
    if (!src) return refuse("IDENTITY_VERSION_UNAVAILABLE");
    PgIdentityCognition.assertParity(src);
    const profile = profileForOperation(facultyPin.operation) ?? refuse("IDENTITY_PROFILE_MISSING");
    const projection = projectIdentity(src.document, profile, identityFramingCeiling(facultyPin.faculty.id, facultyPin.policyVersion));
    const bytes = assertProjectionWithinCap(projection);
    return IdentityCognitionPin.parse({
      tenantId: input.tenantId,
      taskId: input.taskId,
      stepId: input.stepId,
      identityId: current[0].identity_id,
      identityVersionId: src.id,
      identityVersion: src.version,
      identityCoreDigest: src.core_digest_v1,
      classADigest: src.class_a_digest_v1,
      digestContract: "kerneljson:identity-core/v1",
      projectionSchema: "kerneljson:identity-projection/v1",
      projectionProfile: profile,
      projection,
      projectionBytes: bytes,
      projectionDigest: projectionDigest(projection),
      facultyId: facultyPin.faculty.id,
      facultyVersion: facultyPin.faculty.version,
      facultyDigest: facultyPin.facultyDigest,
      mode: "REQUIRED",
    });
  }

  async latch(input: { tenantId: string; taskId: string; stepId: string; facultyPin: FacultyPin | null }): Promise<IdentityCognitionState> {
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`identity-latch:${input.taskId}:${input.stepId}`]);
      const found = await this.read(db, input.tenantId, input.taskId, input.stepId);
      if (found.kind === "LEGACY") {
        if (found.latched) refuse("IDENTITY_LEGACY_TASK_LATCHED");
        await db.query("commit");
        return found.state; // Legacy: the env is not read.
      }
      if (found.latch) {
        await db.query("commit");
        return contractState(found); // A persisted latch wins: the env is not read.
      }
      const facultyPin = input.facultyPin ?? refuse("IDENTITY_FACULTY_PIN_REQUIRED");
      if (facultyPin.tenantId !== input.tenantId || facultyPin.taskId !== input.taskId || facultyPin.stepId !== input.stepId
        || facultyPin.operation !== "RUNTIME_ANALYSE" || facultyPin.faculty.id !== "intelligence")
        refuse("IDENTITY_FACULTY_PIN_REFUSED");
      const binding = (await db.query("select release_epoch from kernel_private.execution_bindings where task_id=$1", [input.taskId])).rows[0];
      const enabled = this.readEnabled(); // The ONE read of KJ_IDENTITY_COGNITION_ENABLED for this step.
      if (enabled) {
        const pin = await this.buildPin(db, input, facultyPin);
        await db.query(
          "insert into public.identity_pins(tenant_id,task_id,step_id,identity_id,identity_version,pin) values($1,$2,$3,$4,$5,$6)",
          [input.tenantId, input.taskId, input.stepId, pin.identityId, pin.identityVersion, pin],
        );
      }
      await db.query(
        "insert into kernel_private.identity_cognition_latches(tenant_id,task_id,step_id,mode,release_epoch) values($1,$2,$3,$4,$5)",
        [input.tenantId, input.taskId, input.stepId, enabled ? "REQUIRED" : "NONE", binding.release_epoch],
      );
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw asRefusal(error);
    } finally {
      db.release();
    }
    // Return the persisted row as re-read after COMMIT, never the values just computed.
    const persisted = await this.read(this.pool, input.tenantId, input.taskId, input.stepId);
    if (persisted.kind !== "CONTRACT" || !persisted.latch) return refuse("IDENTITY_LATCH_NOT_PERSISTED");
    return contractState(persisted);
  }

  async authorize(state: IdentityCognitionState, facultyPin: FacultyPin | null, request: ModelRequest, expectedAssemblyDigest: string): Promise<void> {
    // The exact outgoing request object, recomputed here, immediately before the provider is invoked (D1 erratum).
    if (assemblyDigestOf(request) !== expectedAssemblyDigest) refuse("IDENTITY_ASSEMBLY_MISMATCH");
    const task = (await this.pool.query("select tenant_id, status from public.tasks where id=$1", [request.taskId])).rows[0];
    if (!task) return refuse("IDENTITY_TASK_REFUSED");
    if (task.status !== "RUNNING") refuse("IDENTITY_TASK_NOT_RUNNING");
    const canonical = await this.read(this.pool, task.tenant_id, request.taskId, request.stepId);
    if (canonical.kind === "LEGACY" && canonical.latched) refuse("IDENTITY_LEGACY_TASK_LATCHED");
    if (canonical.kind === "CONTRACT" && !canonical.latch) refuse("IDENTITY_LATCH_MISSING");
    const db = canonical.kind === "LEGACY" ? canonical.state : contractState(canonical);
    // Journal and database must agree exactly; the database is canonical.
    if (canonicalDigest(db) !== canonicalDigest(IdentityCognitionState.parse(state))) refuse("IDENTITY_JOURNAL_DB_MISMATCH");
    const system = request.messages[0]?.content ?? "";
    const blocks = countIdentityBlocks(system);
    if (state.kind === "LEGACY" || state.latch.mode === "NONE") {
      if (blocks !== 0 || (state.kind === "CONTRACT" && state.pin !== null)) refuse("IDENTITY_ASSEMBLY_BLOCK_COUNT");
      return;
    }
    const pin = state.pin ?? refuse("IDENTITY_PIN_MISSING");
    if (blocks !== 1 || !system.includes(renderIdentityBlock(pin.projection, pin.projectionDigest))) refuse("IDENTITY_BLOCK_MISMATCH");
    if (!facultyPin || facultyPin.faculty.id !== pin.facultyId || facultyPin.faculty.version !== pin.facultyVersion || facultyPin.facultyDigest !== pin.facultyDigest)
      refuse("IDENTITY_PIN_FACULTY_MISMATCH");
    // The pinned immutable version, never HEAD.
    const src = await this.source(this.pool, pin.tenantId, pin.identityId, pin.identityVersion);
    if (!src || src.id !== pin.identityVersionId) return refuse("IDENTITY_PINNED_VERSION_UNAVAILABLE");
    PgIdentityCognition.assertParity(src, { core: pin.identityCoreDigest, classA: pin.classADigest });
    const recomputed = projectIdentity(src.document, pin.projectionProfile, identityFramingCeiling(facultyPin!.faculty.id, facultyPin!.policyVersion));
    if (canonicalDigest(recomputed) !== canonicalDigest(pin.projection) || projectionDigest(recomputed) !== pin.projectionDigest)
      refuse("IDENTITY_PROJECTION_MISMATCH");
  }
}
