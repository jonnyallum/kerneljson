export const INFRA_EXIT: 3;
export const VERIFIER_PREFIX: "ENGINE_IMAGE_REFUSED";
export const RECORD_KIND: "kerneljson:g7-attempt/v1";
export const ENV: { nonce: "KJ_G7_NONCE"; label: "KJ_G7_LABEL"; dir: "KJ_G7_RESULTS" };
export const G7_DB_FILES: Readonly<{ testDatabase: string[]; knowledgeDb: string[]; migrate: string[] }>;
export function allDatabaseFiles(): string[];
export function scanDatabaseFiles(root: string): { testDatabase: string[]; knowledgeDb: string[]; migrate: string[] };
export function databaseFileProblems(root: string, lists?: Record<string, readonly string[]>): string[];
export function repoRelative(root: string, file: string): string;
export interface AttemptRecord { kind: string; phase: "started" | "completed" | "failed"; nonce: string; label: string; attemptId: string; file: string; [key: string]: unknown }
export function recordShapeProblems(record: unknown): string[];
export function writeAttemptRecord(dir: string, record: AttemptRecord): void;
export function attemptContext(env?: NodeJS.ProcessEnv): { nonce: string; label: string; dir: string } | null;
export function newAttemptId(): string;
export interface Invocation { label: string; nonce: string; dir: string; createdAt: Date; env: Record<string, string> }
export function createInvocation(label: string, root?: string): Invocation;
export function readRecords(dir: string): { records: AttemptRecord[]; problems: string[] };
export interface PreCheck { containerId: string; digest: string; binding: string; systemIdentifier: string; [key: string]: unknown }
export function recordProblems(records: AttemptRecord[], inv: Pick<Invocation, "nonce" | "label" | "createdAt">, o: { files: string[]; dbFiles: string[]; pre: PreCheck | undefined }): string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reportProblems(report: any, o: { root: string; files: string[]; tests: Map<string, string[]> }): string[];
export function fatalMessage(text: unknown): string | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function acceptInvocation(o: { inv: Invocation; root: string; files: string[]; dbFiles: string[]; tests: Map<string, string[]>; reportPath: string; pre: PreCheck | undefined; spawnError?: string | null }): { ok: boolean; problems: string[]; report: any; records: AttemptRecord[] };
export function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv;
export function runVitest(args: string[], o?: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; vitest?: string }): { code: number | null; signal: string | null; error: string | null; out: string };
export function listTests(files: string[], o?: { cwd?: string; filter?: string[]; env?: Record<string, string | undefined>; vitest?: string }): Map<string, string[]>;
export function preInvocationCheck(o?: { cwd?: string; command?: string[] }): PreCheck;
export function createRestorer(backup: string, o?: { log?: (s: string) => void }): { save(file: string, text: string): void; restore(): void; originals: Map<string, string> };
export function infrastructureFailure(label: string, reason: string, restore?: () => void, exit?: (code: number) => never | unknown): never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function runClassified(o: { label: string; files: string[]; filter?: string[]; tests: Map<string, string[]>; root?: string; restore?: () => void; logDir?: string; timeout?: number; check?: (o: { cwd: string }) => PreCheck; vitest?: string; exit?: (code: number) => unknown; extraEnv?: Record<string, string | undefined>; dbFiles?: string[] }): { code: number | null; failed: number; total: number; report: any; pre: PreCheck; records: number };
