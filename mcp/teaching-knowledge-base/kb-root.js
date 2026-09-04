/**
 * Knowledge-base root resolution for the teaching-knowledge-base MCP server.
 *
 * Resolution order (shared by SKILL.md, this server, and the PreCompact hook):
 *   1. $SYSTEM_EXPLAINER_HOME/references          when the variable is set
 *   2. <git-root>/.system-explainer/references    when that directory exists
 *   3. ~/.system-explainer/references             otherwise
 *
 * Systems that live under the legacy in-skill location
 * (~/.claude/skills/system-explainer/references/<system>) keep working in
 * place: resolveSystemDir() falls back to the legacy directory when the system
 * exists there and not under the resolved root. Nothing is migrated silently.
 *
 * Everything this module reads (env, cwd, home, the filesystem, the git root)
 * is injectable, so the resolution is testable without real machine state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function legacyReferencesBase(home = os.homedir()) {
  return path.join(home, ".claude/skills/system-explainer/references");
}

export const LEGACY_REFERENCES_BASE = legacyReferencesBase();

// Walk up from cwd to the first directory containing .git (a directory, or a
// worktree's .git file). null when there is none.
function findGitRoot(cwd, exists) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveReferencesBase({
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
  exists = fs.existsSync,
  gitRoot = findGitRoot(cwd, exists),
} = {}) {
  if (env.SYSTEM_EXPLAINER_HOME) {
    return path.resolve(cwd, env.SYSTEM_EXPLAINER_HOME, "references");
  }
  if (gitRoot) {
    const local = path.join(gitRoot, ".system-explainer", "references");
    if (exists(local)) return local;
  }
  return path.join(home, ".system-explainer", "references");
}

function pathForSystem(base, system) {
  // Reject obviously bad inputs
  if (!system || typeof system !== "string") {
    throw new Error(`Invalid system name: must be a non-empty string.`);
  }
  // Reject path-traversal patterns and any path separators (system names are simple dir names)
  if (
    system.includes("..") ||
    system.includes("/") ||
    system.includes("\\") ||
    system.startsWith(".")
  ) {
    throw new Error(
      `Invalid system name "${system}" — must be a simple directory name (no slashes, no '..', no leading '.').`
    );
  }
  // Resolve the path and verify it stays under the references base
  const resolved = path.resolve(path.join(base, system));
  const resolvedBase = path.resolve(base);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(
      `Invalid system name "${system}" — resolved path escapes references base.`
    );
  }
  return resolved;
}

// <base>/<system> when it exists; else the legacy <system> when THAT exists
// (legacy systems keep working in place); else <base>/<system>, the
// not-yet-created default.
export function resolveSystemDir(system, opts = {}) {
  const { home = os.homedir(), exists = fs.existsSync } = opts;
  const dir = pathForSystem(resolveReferencesBase(opts), system);
  if (exists(dir)) return dir;
  const legacyDir = pathForSystem(legacyReferencesBase(home), system);
  return exists(legacyDir) ? legacyDir : dir;
}
