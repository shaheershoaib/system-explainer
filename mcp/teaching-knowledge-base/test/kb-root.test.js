import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  LEGACY_REFERENCES_BASE,
  legacyReferencesBase,
  resolveReferencesBase,
  resolveSystemDir,
} from "../kb-root.js";

const HOME = "/home/tester";
const HOME_BASE = path.join(HOME, ".system-explainer", "references");
const LEGACY = path.join(HOME, ".claude/skills/system-explainer/references");
const never = () => false;

test("SYSTEM_EXPLAINER_HOME wins over a project-local dir and the home default", () => {
  const base = resolveReferencesBase({
    env: { SYSTEM_EXPLAINER_HOME: "/kb" },
    cwd: "/repo",
    home: HOME,
    exists: () => true,
    gitRoot: "/repo",
  });
  assert.equal(base, "/kb/references");
  // A relative value resolves against cwd.
  assert.equal(
    resolveReferencesBase({ env: { SYSTEM_EXPLAINER_HOME: "kb" }, cwd: "/repo", home: HOME, gitRoot: null }),
    "/repo/kb/references"
  );
});

test("project-local .system-explainer/references wins when the directory exists", () => {
  const local = "/repo/.system-explainer/references";
  // Injected git root.
  assert.equal(
    resolveReferencesBase({ env: {}, cwd: "/repo", home: HOME, exists: (p) => p === local, gitRoot: "/repo" }),
    local
  );
  // Default git root: walk up from cwd to the first dir containing .git.
  assert.equal(
    resolveReferencesBase({
      env: {},
      cwd: "/repo/src/deep",
      home: HOME,
      exists: (p) => p === "/repo/.git" || p === local,
    }),
    local
  );
});

test("home default when there is no env override and no project-local dir", () => {
  // Inside a git repo without a .system-explainer/references dir.
  assert.equal(resolveReferencesBase({ env: {}, cwd: "/repo", home: HOME, exists: never, gitRoot: "/repo" }), HOME_BASE);
  // Outside any git repo (walk reaches the filesystem root).
  assert.equal(resolveReferencesBase({ env: {}, cwd: "/elsewhere/dir", home: HOME, exists: never }), HOME_BASE);
  // An empty env value counts as unset.
  assert.equal(resolveReferencesBase({ env: { SYSTEM_EXPLAINER_HOME: "" }, home: HOME, exists: never, gitRoot: null }), HOME_BASE);
});

test("legacy fallback is decided per system", () => {
  const present = new Set([
    path.join(HOME_BASE, "new-system"),
    path.join(LEGACY, "old-system"),
    path.join(HOME_BASE, "both"),
    path.join(LEGACY, "both"),
  ]);
  const opts = { env: {}, home: HOME, gitRoot: null, exists: (p) => present.has(p) };
  // Exists under the resolved base: use it.
  assert.equal(resolveSystemDir("new-system", opts), path.join(HOME_BASE, "new-system"));
  // Exists only under the legacy base: keep working there in place.
  assert.equal(resolveSystemDir("old-system", opts), path.join(LEGACY, "old-system"));
  // Present in both: the resolved base wins.
  assert.equal(resolveSystemDir("both", opts), path.join(HOME_BASE, "both"));
  // Not yet created anywhere: the resolved base is the default.
  assert.equal(resolveSystemDir("fresh-system", opts), path.join(HOME_BASE, "fresh-system"));
  // The env override participates in the same resolution.
  assert.equal(
    resolveSystemDir("fresh-system", { ...opts, env: { SYSTEM_EXPLAINER_HOME: "/kb" } }),
    "/kb/references/fresh-system"
  );
});

test("path-traversal and malformed system names are rejected", () => {
  const opts = { env: {}, home: HOME, gitRoot: null, exists: () => true };
  for (const bad of ["..", "../etc", "a/../../b", "a/b", "a\\b", ".hidden", "", 42, null, undefined]) {
    assert.throws(() => resolveSystemDir(bad, opts), /Invalid system name/, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveSystemDir("plain-name_1", opts), path.join(HOME_BASE, "plain-name_1"));
});

test("legacy base is a function of home, with the real home as the exported constant", () => {
  assert.equal(legacyReferencesBase(HOME), LEGACY);
  assert.equal(LEGACY_REFERENCES_BASE, path.join(os.homedir(), ".claude/skills/system-explainer/references"));
});
