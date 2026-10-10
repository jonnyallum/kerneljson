import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository root, from this file's own location. ADR-0023 27.12.15 runs a stage T suite in a fresh empty working
 * directory, so a lane D file never resolves a repository path against process.cwd().
 */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const repoPath = (path: string): string => join(REPO_ROOT, path);
