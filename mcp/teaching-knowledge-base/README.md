# teaching-knowledge-base MCP server

A dependency-free MCP server that enforces structured writes to a system-explainer knowledge base. The skill accumulates three markdown files per taught system, and across many sessions freeform appends drift in format (field order, headings, terminology). This server exposes one tool per kind of write so every entry lands in the same shape.

The markdown files stay the source of truth and stay human-readable. The server only enforces the format of new entries; reads still go through ordinary file access.

Per system, under `<kb-root>/<system>/`:

- `gotchas.md`: open design questions, ambiguities, SME items
- `learning-log.md`: the teaching journey (domains locked, corrections, outstanding queue)
- `context-index.md`: catalog of relevant context sources
- `compaction-markers.md`: markers written when conversation context was compacted mid-session

Runs on Node 20 or newer with no `npm install`: it uses `node:` builtins only and speaks MCP over stdio (newline-delimited JSON-RPC 2.0) directly, so it starts straight from a plugin cache.

## Tools

| Tool | Writes to | Purpose |
|---|---|---|
| `append_gotcha` | `gotchas.md` | Append a gotcha with required fields (domain, category, severity, files, code quote, why it is a gotcha, SME question). The severity input auto-strips a leading `⚠`, `⚡` or `!`. |
| `lock_domain` | `learning-log.md` | Append a domain entry when a Phase 2 teaching cycle locks (or partially locks) a domain. Supports the status-conditional optional fields `covered`, `not_yet_covered`, `open_questions`, `build_implication`. |
| `add_context_entry` | `context-index.md` | Insert an entry under a canonical section (matched case-insensitively). Rejects an ambiguous section match and lists the candidates. |
| `record_compaction_marker` | `compaction-markers.md` | Manually record a compaction marker (complements the PreCompact hook in `hooks/pre-compact-teaching-snapshot.sh`, which writes the same marker automatically). |
| `mark_stale` | `context-index.md` | Append `*(stale)*` (or `*(stale — reason)*`) to one matching entry line. Not for `gotchas.md` or `learning-log.md`, which are append-only. |
| `list_systems` | nothing | List the systems under the resolved knowledge-base root (`systems`) and, when the legacy root exists, the systems still living there (`legacy_systems`), plus both root paths. |

Every write tool returns the absolute path it wrote to (`file_written`), so a session can confirm where an entry landed.

Fixed enums, validated before any write:

- Gotcha categories: `Non-obvious behavior` | `Edge case` | `Design ambiguity` | `Possible bug` | `SME question`
- Severities: `High` | `Medium` | `Low`
- Domain statuses: `LOCKED` | `PARTIALLY LOCKED` | `TAUGHT (with open questions)` | `RECOMMENDATION` | `NOT STARTED`
- Context-index sections: `Knowledge base files` | `Source code` | `User-maintained planning` | `Meeting / feedback` | `Vendor / third-party` | `Domain references` | `Methodology notes` | `Stale / superseded`

An invalid value is reported back as an `isError` tool result and nothing is written.

## Where the knowledge base lives

The root is resolved in this order (`kb-root.js`; the skill and the PreCompact hook use the same order):

1. `$SYSTEM_EXPLAINER_HOME/references` when the variable is set
2. `<git-root>/.system-explainer/references` when that directory exists (git root: the nearest ancestor of the working directory containing `.git`)
3. `~/.system-explainer/references` otherwise

A project-local root can be committed, which makes the knowledge base a team artifact. The root is deliberately outside the skill directory: a plugin cache is replaced on update, so anything stored inside it would be deleted.

Legacy note: systems created by earlier versions under `~/.claude/skills/system-explainer/references/<system>` keep working in place. When a system is not found under the resolved root but exists under the legacy root, reads and writes go to the legacy directory. Nothing is migrated silently; move a directory yourself when you want it under the new root.

A system must already exist (its directory under the resolved root or the legacy root) before any write tool will touch it. Phase 0 of the skill creates the scaffold.

## Registration

Installed as a Claude Code plugin, the server is registered automatically by the repository's `.mcp.json`:

```json
{
  "mcpServers": {
    "teaching-knowledge-base": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/teaching-knowledge-base/index.js"]
    }
  }
}
```

Without the plugin (a clone, or a skills.sh install), register it manually once:

```bash
claude mcp add --scope user teaching-knowledge-base -- node /abs/path/mcp/teaching-knowledge-base/index.js
```

Restart the Claude Code session afterwards; MCP servers load at session start.

## Manual invocation

The server reads one JSON-RPC message per line on stdin and writes one response per line on stdout (nothing else goes to stdout; diagnostics go to stderr). Requests without an `id` are notifications and get no response.

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/teaching-knowledge-base/index.js
```

The first line printed is the `initialize` result; the second lists the six tools. To call a tool the same way:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_systems","arguments":{}}}' \
  | node mcp/teaching-knowledge-base/index.js
```

Supported protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05` (the client's version is echoed when it is one of these, else `2025-06-18`). Unknown methods return JSON-RPC error `-32601`; an unparseable line returns `-32700`. Tool failures (validation, unknown system, unknown tool) come back as a normal result with `isError: true`, never as a JSON-RPC error.

## Tests

```bash
node --test mcp/teaching-knowledge-base/test/*.test.js
```

`node:test` only, no dependencies. `kb-root.test.js` covers the resolution order and the legacy fallback; `server.test.js` spawns the server against a temporary knowledge base and drives it over stdio. (On Node 20 the directory form `node --test mcp/teaching-knowledge-base/test/` also works; from Node 21 positional arguments are glob patterns, so use the pattern above.)

## Limitations

- `gotchas.md` and `learning-log.md` writes are strictly append-only. There are no edit or delete tools, which preserves the audit trail. To correct a past entry, append a new one that supersedes it and say so in the new entry.
- `context-index.md` supports `mark_stale` for entries that are no longer authoritative. Stale entries remain in the file with a `*(stale)*` annotation; they are not deleted.
- No reads. The server focuses on writes; reads go through ordinary file access. Structured read tools can be added later if they turn out to matter.
- The system must already exist. The server refuses to write when `<kb-root>/<system>/` (or its legacy equivalent) does not exist. Run the skill's Phase 0 to create the scaffold first.
- System names are sanitized. Path-traversal patterns (`..`, slashes, a leading `.`) are rejected at the API boundary. Use simple directory names only.

## Extending it

- Tool input schemas live in the `TOOLS` array in `index.js`.
- Markdown templates live in `appendGotcha`, `lockDomain`, `addContextEntry` and `buildCompactionMarker`. The compaction-marker template is mirrored by `hooks/pre-compact-teaching-snapshot.sh`; the two must stay byte-identical, so change both together.
- Validation enums are at the top of the "Tool implementations" section.

After edits, restart any Claude Code session; the server reloads on session start.
