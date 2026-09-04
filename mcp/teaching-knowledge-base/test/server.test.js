import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(new URL("../index.js", import.meta.url));
const TOOL_NAMES = [
  "append_gotcha",
  "lock_domain",
  "add_context_entry",
  "record_compaction_marker",
  "mark_stale",
  "list_systems",
];

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const notify = (method) => JSON.stringify({ jsonrpc: "2.0", method });

// Spawns the server with SYSTEM_EXPLAINER_HOME=kbHome, writes every line, closes
// stdin, and returns the parsed newline-delimited responses plus the exit status.
function runServer(kbHome, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: { ...process.env, SYSTEM_EXPLAINER_HOME: kbHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const responses = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      resolve({ code, signal, stderr, responses });
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
}

async function freshKb() {
  const kbHome = await fs.mkdtemp(path.join(os.tmpdir(), "system-explainer-kb-"));
  const systemDir = path.join(kbHome, "references", "demo-system");
  await fs.mkdir(systemDir, { recursive: true });
  const gotchas = path.join(systemDir, "gotchas.md");
  await fs.writeFile(gotchas, "# demo-system — Gotchas & Open Questions\n");
  return { kbHome, gotchas };
}

test("initialize, tools/list, list_systems, append_gotcha valid + invalid, clean exit", async () => {
  const { kbHome, gotchas } = await freshKb();
  const gotcha = {
    system: "demo-system",
    domain: "Store",
    title: "Selectors run on every render",
    category: "Non-obvious behavior",
    severity: "⚠ High",
    files: ["src/store.js", "src/hooks.js"],
    code_quote: "const value = useStore((s) => s.value); // src/hooks.js:12",
    why_gotcha: "The selector closure is re-created on each render, so equality checks never short-circuit.",
    sme_question: "Should selectors be memoized by default, or is the re-run intended?",
  };

  const { code, signal, stderr, responses } = await runServer(kbHome, [
    rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    notify("notifications/initialized"),
    rpc(2, "tools/list"),
    rpc(3, "tools/call", { name: "list_systems", arguments: {} }),
    rpc(4, "tools/call", { name: "append_gotcha", arguments: gotcha }),
    rpc(5, "tools/call", { name: "append_gotcha", arguments: { ...gotcha, category: "Not a category" } }),
  ]);

  assert.equal(code, 0, `expected a clean exit when stdin closes; stderr: ${stderr}`);
  assert.equal(signal, null);

  // One response per request, none for the notification, all well-formed.
  assert.deepEqual(responses.map((r) => r.id).sort(), [1, 2, 3, 4, 5]);
  for (const r of responses) assert.equal(r.jsonrpc, "2.0");
  const byId = Object.fromEntries(responses.map((r) => [r.id, r]));

  assert.deepEqual(byId[1].result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "teaching-knowledge-base", version: "3.0.0" },
  });

  assert.deepEqual(byId[2].result.tools.map((t) => t.name), TOOL_NAMES);
  for (const t of byId[2].result.tools) assert.equal(t.inputSchema.type, "object");

  const listed = JSON.parse(byId[3].result.content[0].text);
  assert.ok(listed.systems.includes("demo-system"), `systems: ${JSON.stringify(listed.systems)}`);
  assert.equal(listed.references_base, path.join(kbHome, "references"));
  assert.equal(typeof listed.legacy_base, "string");

  const appended = JSON.parse(byId[4].result.content[0].text);
  assert.equal(byId[4].result.isError, undefined);
  assert.equal(appended.success, true);
  assert.equal(appended.file_written, gotchas);
  assert.equal(appended.entry_title, "Non-obvious behavior — Selectors run on every render");

  const today = new Date().toISOString().slice(0, 10);
  const text = await fs.readFile(gotchas, "utf8");
  assert.ok(text.startsWith("# demo-system — Gotchas & Open Questions\n"), "existing heading preserved");
  assert.ok(
    text.endsWith(
      "\n---\n\n" +
        "## Non-obvious behavior — Selectors run on every render\n\n" +
        `**Discovered:** ${today}\n` +
        "**Domain:** Store\n" +
        "**Severity:** High\n" +
        "**Files involved:** src/store.js, src/hooks.js\n\n" +
        "### What the code does\n\n" +
        "const value = useStore((s) => s.value); // src/hooks.js:12\n\n" +
        "### Why it's a gotcha\n\n" +
        "The selector closure is re-created on each render, so equality checks never short-circuit.\n\n" +
        "### Suggested question for SME / build phase\n\n" +
        "Should selectors be memoized by default, or is the re-run intended?\n"
    ),
    `appended entry did not match the template:\n${text}`
  );

  assert.equal(byId[5].result.isError, true);
  assert.match(byId[5].result.content[0].text, /^Error: Invalid category "Not a category"\. Must be one of: /);
  assert.equal(await fs.readFile(gotchas, "utf8"), text, "the rejected call must not write");
});

test("protocol edges: ping, version negotiation, unknown method, parse error, notifications", async () => {
  const { kbHome } = await freshKb();
  const { code, responses } = await runServer(kbHome, [
    rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    rpc(2, "initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    notify("notifications/initialized"),
    notify("notifications/cancelled"),
    rpc(3, "ping"),
    rpc(4, "no/such-method"),
    "{not json",
    rpc(5, "tools/call", { name: "no_such_tool", arguments: {} }),
    rpc(6, "tools/call", { name: "append_gotcha", arguments: { system: "../demo-system", domain: "d", title: "t", category: "Edge case", code_quote: "c", why_gotcha: "w", sme_question: "q" } }),
  ]);

  assert.equal(code, 0);
  const byId = Object.fromEntries(responses.map((r) => [String(r.id), r]));
  assert.equal(responses.length, 7, JSON.stringify(responses));

  assert.equal(byId["1"].result.protocolVersion, "2024-11-05");
  assert.equal(byId["2"].result.protocolVersion, "2025-06-18");
  assert.deepEqual(byId["3"].result, {});
  assert.equal(byId["4"].error.code, -32601);
  assert.equal(byId["null"].error.code, -32700);
  // Tool-level failures are isError content, never JSON-RPC errors.
  assert.equal(byId["5"].result.isError, true);
  assert.equal(byId["5"].result.content[0].text, "Error: Unknown tool: no_such_tool");
  assert.equal(byId["6"].result.isError, true);
  assert.match(byId["6"].result.content[0].text, /Invalid system name "\.\.\/demo-system"/);
});
