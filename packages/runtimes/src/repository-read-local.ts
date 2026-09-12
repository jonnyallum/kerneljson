import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  RepositoryReadInput,
  RepositoryReadOutput,
} from "../../capabilities/src/index.js";

/**
 * Sealed-local `repository.read` backend (Gate 3, KernelJSON VM).
 *
 * A tightly-confined, read-only, deterministic file read that fills the execution
 * the `repository.read` capability declares but intentionally leaves throwing
 * (packages/capabilities: `repositoryReadDefinition().execute` throws so the id has
 * no ambient implementation). It is NOT the new-system Spawner: no network, no
 * credential, no shell. It resolves a single file UNDER a configured repository root
 * and returns its LF-form content_sha256 with `mutations_detected=0` — exactly the
 * `RepositoryReadOutput` contract the canary verifier consumes.
 *
 * Confinement (all fail closed): absolute target rejected; `..` traversal rejected;
 * a resolved path outside the root rejected; a symlink whose real target escapes the
 * root rejected; a byte size over the cap rejected. `repo_path` from the request is
 * IGNORED — the root is server configuration, never caller-controlled.
 */

export type RepositoryReadInputValue = z.infer<typeof RepositoryReadInput>;
export type RepositoryReadOutputValue = z.infer<typeof RepositoryReadOutput>;

export type SealedReadCode =
  | "TARGET_REQUIRED"
  | "ABSOLUTE_PATH_REJECTED"
  | "TRAVERSAL_REJECTED"
  | "OUTSIDE_ROOT_REJECTED"
  | "SYMLINK_ESCAPE_REJECTED"
  | "FILE_TOO_LARGE"
  | "READ_FAILED";

export class SealedReadError extends Error {
  constructor(readonly code: SealedReadCode) {
    super(code);
    this.name = "SealedReadError";
  }
}

export interface SealedRepositoryReaderConfig {
  /** Absolute repository root the read is confined to (e.g. `/opt/kerneljson/app`). */
  repositoryRoot: string;
  /** Maximum file size in bytes; a larger file fails closed. Default 1 MiB. */
  maxBytes?: number;
  /** Project label in the receipt (non-secret). Defaults to the root's basename. */
  projectName?: string;
}

/** LF-normalise at the byte level (strip CR, 0x0d), so the hash equals the committed
 *  LF-form SHA-256 regardless of the checkout's line endings. No content is returned. */
function lfNormalise(raw: Buffer): Buffer {
  return Buffer.from(raw.filter((b) => b !== 0x0d));
}

/**
 * Build the sealed reader closed over an immutable, realpath-resolved root. The
 * returned function is synchronous (the CapabilityDefinition.execute contract) and
 * pure w.r.t. the filesystem: same file bytes -> same receipt.
 */
export function createSealedRepositoryReader(
  config: SealedRepositoryReaderConfig,
): (input: RepositoryReadInputValue) => RepositoryReadOutputValue {
  const rootReal = realpathSync(resolve(config.repositoryRoot));
  const maxBytes = config.maxBytes ?? 1_000_000;
  const projectName =
    config.projectName ??
    rootReal.split(/[\\/]/).filter(Boolean).at(-1) ??
    "repository";

  return (input: RepositoryReadInputValue): RepositoryReadOutputValue => {
    const targetFile = input.target_file;
    if (!targetFile) throw new SealedReadError("TARGET_REQUIRED");
    if (isAbsolute(targetFile)) throw new SealedReadError("ABSOLUTE_PATH_REJECTED");
    if (targetFile.split(/[\\/]/).includes(".."))
      throw new SealedReadError("TRAVERSAL_REJECTED");

    const resolved = resolve(rootReal, targetFile);
    const rel = relative(rootReal, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      throw new SealedReadError("OUTSIDE_ROOT_REJECTED");

    // Symlink escape: the real path must still be inside the root.
    let real: string;
    try {
      real = realpathSync(resolved);
    } catch {
      throw new SealedReadError("READ_FAILED");
    }
    const realRel = relative(rootReal, real);
    if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel))
      throw new SealedReadError("SYMLINK_ESCAPE_REJECTED");

    let raw: Buffer;
    try {
      raw = readFileSync(real);
    } catch {
      throw new SealedReadError("READ_FAILED");
    }
    if (raw.length > maxBytes) throw new SealedReadError("FILE_TOO_LARGE");

    const norm = lfNormalise(raw);
    const contentSha256 = createHash("sha256").update(norm).digest("hex");
    const newlines = norm.filter((b) => b === 0x0a).length;
    const linesRead =
      norm.length === 0
        ? 0
        : norm[norm.length - 1] === 0x0a
          ? newlines
          : newlines + 1;
    const targetPath = targetFile.replaceAll("\\", "/");

    return RepositoryReadOutput.parse({
      capability: "repository.read",
      project_name: projectName,
      target_path: targetPath,
      bytes_read: norm.length,
      lines_read: linesRead,
      content_sha256: contentSha256,
      output_hash: contentSha256,
      skills_mounted: [],
      mutations_detected: 0,
      summary: `sealed repository.read of ${targetPath}: ${norm.length} bytes, mutations 0`,
    });
  };
}
