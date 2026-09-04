#!/usr/bin/env node
/**
 * Teaching Knowledge Base MCP Server
 *
 * Enforces structured writes to the system-explainer skill's knowledge base
 * files so entries don't drift across sessions.
 *
 * Manages three files per system at <kb-root>/<system>/ (kb-root.js resolves
 * <kb-root>: $SYSTEM_EXPLAINER_HOME/references, else
 * <git-root>/.system-explainer/references when that directory exists, else
 * ~/.system-explainer/references; systems under the legacy
 * ~/.claude/skills/system-explainer/references keep working in place):
 *   - gotchas.md       (open design questions, ambiguities, SME items)
 *   - learning-log.md  (teaching journey: domains locked, corrections, outstanding queue)
 *   - context-index.md (catalog of all relevant context sources)
 *
 * Markdown remains the source of truth and human-readable. This MCP just
 * enforces a consistent schema on appends.
 *
 * Zero dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0, handled
 * at the bottom of this file with node: builtins only, so the server starts
 * straight from a plugin cache (a plugin install runs no `npm install`).
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
  LEGACY_REFERENCES_BASE,
  resolveReferencesBase,
  resolveSystemDir,
} from "./kb-root.js";

const REFERENCES_BASE = resolveReferencesBase();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoTimestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// Validates the system name, resolves its directory (new root, else legacy
// root) and returns it; throws when the knowledge base has not been created.
async function ensureSystemExists(system) {
  const dir = resolveSystemDir(system);
  try {
    await fs.access(dir);
  } catch {
    throw new Error(
      `Knowledge base for system "${system}" not found at ${dir}. ` +
        `Run the system-explainer skill's Phase 0 configuration first.`
    );
  }
  return dir;
}

async function ensureFileExists(filePath, initialContent = "") {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, initialContent);
  }
}

function bulletize(items, prefix = "- ") {
  if (!items) return "- (none recorded)";
  if (Array.isArray(items)) {
    if (items.length === 0) return "- (none recorded)";
    return items.map((item) => `${prefix}${item}`).join("\n");
  }
  // String case: if it doesn't already look like a bulleted list, prepend a bullet
  const str = String(items).trim();
  if (!str) return "- (none recorded)";
  if (str.startsWith("- ") || str.startsWith("* ") || str.startsWith("\n")) {
    return str;
  }
  return `${prefix}${str}`;
}

function joinList(items) {
  if (!items) return "—";
  if (Array.isArray(items)) {
    if (items.length === 0) return "—";
    return items.join(", ");
  }
  const str = String(items).trim();
  return str || "—";
}

// Normalize severity input — accept "⚠ High" (gotcha-finder agent's output format) by stripping the symbol
function normalizeSeverity(severity) {
  if (!severity) return "Medium";
  return String(severity).replace(/^[⚠⚡!]+\s*/u, "").trim();
}

// Shared compaction-marker template — used by both record_compaction_marker (MCP)
// and the PreCompact shell hook (which has its own copy in sync). If you change
// this, update the hook script at hooks/pre-compact-teaching-snapshot.sh too.
function buildCompactionMarker(timestamp, note) {
  return `
---

## Compaction marker — ${timestamp}

${note}

**For the agent re-engaging:** treat this as a signal to re-read this learning log, gotchas.md, and context-index.md in full before responding. Do not produce content from compacted memory alone. If unsure about recent context, ask the user to confirm where you left off.
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

const VALID_GOTCHA_CATEGORIES = [
  "Non-obvious behavior",
  "Edge case",
  "Design ambiguity",
  "Possible bug",
  "SME question",
];

const VALID_SEVERITIES = ["High", "Medium", "Low"];

const VALID_DOMAIN_STATUSES = [
  "LOCKED",
  "PARTIALLY LOCKED",
  "TAUGHT (with open questions)",
  "RECOMMENDATION",
  "NOT STARTED",
];

// Canonical sections in context-index.md (per Phase 0.3 template).
// add_context_entry validates section input against substring matches of these
// to prevent ambiguous matches against arbitrary user-created headings.
const VALID_CONTEXT_SECTIONS = [
  "Knowledge base files",
  "Source code",
  "User-maintained planning",
  "Meeting / feedback",
  "Vendor / third-party",
  "Domain references",
  "Methodology notes",
  "Stale / superseded",
];

async function appendGotcha(args) {
  const {
    system,
    domain,
    title,
    category,
    files,
    code_quote,
    why_gotcha,
    sme_question,
  } = args;

  // Normalize severity — strip leading ⚠ / ⚡ / ! symbols (gotcha-finder agent output format)
  const severity = normalizeSeverity(args.severity);

  // Validation
  if (!system || !domain || !title || !category || !code_quote || !why_gotcha || !sme_question) {
    throw new Error(
      "Missing required fields. Required: system, domain, title, category, code_quote, why_gotcha, sme_question."
    );
  }
  if (!VALID_GOTCHA_CATEGORIES.includes(category)) {
    throw new Error(
      `Invalid category "${category}". Must be one of: ${VALID_GOTCHA_CATEGORIES.join(", ")}.`
    );
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(
      `Invalid severity "${severity}" (normalized from "${args.severity}"). Must be one of: ${VALID_SEVERITIES.join(", ")}.`
    );
  }

  const dir = await ensureSystemExists(system);
  const date = isoDate();
  const filesStr = joinList(files);

  const entry = `
---

## ${category} — ${title}

**Discovered:** ${date}
**Domain:** ${domain}
**Severity:** ${severity}
**Files involved:** ${filesStr}

### What the code does

${code_quote}

### Why it's a gotcha

${why_gotcha}

### Suggested question for SME / build phase

${sme_question}
`;

  const gotchasPath = path.join(dir, "gotchas.md");
  await ensureFileExists(gotchasPath, `# ${system} — Gotchas & Open Questions\n\nNon-obvious behaviors, edge cases, and questions that emerged during teaching sessions and need SME validation.\n`);
  await fs.appendFile(gotchasPath, entry);

  return {
    success: true,
    file_written: gotchasPath,
    date,
    entry_title: `${category} — ${title}`,
  };
}

async function lockDomain(args) {
  const {
    system,
    name,
    status,
    entities_taught,
    mental_model,
    corrections,
    reference_files,
    outstanding,
    // Status-conditional optional fields
    covered,           // For PARTIALLY LOCKED / TAUGHT entries — what's been covered so far
    not_yet_covered,   // For PARTIALLY LOCKED entries — what remains
    open_questions,    // For TAUGHT (with open questions) entries
    build_implication, // For RECOMMENDATION entries
  } = args;

  if (!system || !name || !status || !entities_taught || !mental_model) {
    throw new Error(
      "Missing required fields. Required: system, name, status, entities_taught, mental_model."
    );
  }
  if (!VALID_DOMAIN_STATUSES.includes(status)) {
    throw new Error(
      `Invalid status "${status}". Must be one of: ${VALID_DOMAIN_STATUSES.join(", ")}.`
    );
  }

  const dir = await ensureSystemExists(system);
  const date = isoDate();

  const correctionsBlock = bulletize(corrections);
  const referenceFilesStr = joinList(reference_files);

  // Build status-conditional sections
  const optionalSections = [];
  if (covered) {
    optionalSections.push(`**Covered:**\n${bulletize(covered)}`);
  }
  if (not_yet_covered) {
    optionalSections.push(`**Not yet covered:**\n${bulletize(not_yet_covered)}`);
  }
  if (open_questions) {
    optionalSections.push(`**Open questions (logged in gotchas.md):**\n${bulletize(open_questions)}`);
  }
  if (build_implication) {
    optionalSections.push(`**Build implication flagged:** ${build_implication}`);
  }
  const optionalBlock = optionalSections.length > 0
    ? "\n" + optionalSections.join("\n\n") + "\n"
    : "";

  const entry = `
---

## Domain: ${name} — ${status} (${date})

**Entities taught:** ${entities_taught}

**Mental model locked:**
${mental_model}
${optionalBlock}
**Corrections during teaching:**
${correctionsBlock}

**Reference files:** ${referenceFilesStr}

**Outstanding:** ${outstanding || "none for this domain."}
`;

  const logPath = path.join(dir, "learning-log.md");
  await ensureFileExists(
    logPath,
    `# ${system} — Learning Log\n\n**Purpose:** Track what's been taught, locked, corrected, and what remains. Append-only — preserve the history of corrections rather than just the latest state. Re-read in full at the start of any re-engagement.\n`
  );
  await fs.appendFile(logPath, entry);

  return {
    success: true,
    file_written: logPath,
    date,
    domain: name,
    status,
  };
}

async function addContextEntry(args) {
  const { system, section, entry_path, description, status = "active" } = args;

  if (!system || !section || !entry_path || !description) {
    throw new Error(
      "Missing required fields. Required: system, section, entry_path, description."
    );
  }

  // Validate that the requested section is in the canonical allowlist.
  // Use substring match in both directions to allow flexible matching
  // (e.g., "vendor" matches "Vendor / third-party").
  const sectionLower = section.toLowerCase();
  const allowedMatches = VALID_CONTEXT_SECTIONS.filter((valid) => {
    const validLower = valid.toLowerCase();
    return validLower.includes(sectionLower) || sectionLower.includes(validLower);
  });
  if (allowedMatches.length === 0) {
    throw new Error(
      `Section "${section}" does not match any canonical section. Canonical sections: ${VALID_CONTEXT_SECTIONS.join(" | ")}. If you need a non-canonical section, edit context-index.md directly and add a fallback entry.`
    );
  }
  if (allowedMatches.length > 1) {
    throw new Error(
      `Section "${section}" is ambiguous — matches multiple canonical sections: ${allowedMatches.join(" | ")}. Be more specific.`
    );
  }

  const dir = await ensureSystemExists(system);

  const indexPath = path.join(dir, "context-index.md");
  let content;
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch {
    throw new Error(
      `context-index.md not found at ${indexPath}. Run the system-explainer skill's Phase 0 to create it first.`
    );
  }

  // Find the section header line in the actual file using the canonical match
  const canonicalMatch = allowedMatches[0];
  const canonicalLower = canonicalMatch.toLowerCase();
  const lines = content.split("\n");
  const headingMatches = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ") && lines[i].toLowerCase().includes(canonicalLower)) {
      headingMatches.push(i);
    }
  }
  if (headingMatches.length === 0) {
    const availableSections = lines
      .filter((l) => l.startsWith("## "))
      .map((l) => l.replace(/^## /, "").trim());
    throw new Error(
      `Canonical section "${canonicalMatch}" not found as a heading in context-index.md. Available headings: ${availableSections.join(" | ")}. The file may have been hand-edited away from the standard template.`
    );
  }
  if (headingMatches.length > 1) {
    throw new Error(
      `Canonical section "${canonicalMatch}" appears as a heading more than once in context-index.md (lines: ${headingMatches.map((i) => i + 1).join(", ")}). Resolve the duplicate manually before re-trying.`
    );
  }
  const sectionLineIdx = headingMatches[0];

  // Find the next section (or end of file)
  let nextSectionLineIdx = lines.length;
  for (let i = sectionLineIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      nextSectionLineIdx = i;
      break;
    }
  }

  // Build the entry line
  const statusSuffix = status !== "active" ? ` *(${status})*` : "";
  const entryLine = `- \`${entry_path}\` — ${description}${statusSuffix}`;

  // Insert just before the next section, trimming trailing blank lines from the section
  let insertIdx = nextSectionLineIdx - 1;
  while (insertIdx > sectionLineIdx && lines[insertIdx].trim() === "") {
    insertIdx--;
  }

  // Insert after insertIdx
  const newLines = [
    ...lines.slice(0, insertIdx + 1),
    entryLine,
    ...lines.slice(insertIdx + 1),
  ];

  await fs.writeFile(indexPath, newLines.join("\n"));

  return {
    success: true,
    file_written: indexPath,
    section_matched: lines[sectionLineIdx].replace(/^## /, "").trim(),
    canonical_section: canonicalMatch,
    entry_added: entryLine,
  };
}

async function recordCompactionMarker(args) {
  // Convenience tool to manually record a compaction marker. Writes to a separate
  // compaction-markers.md file (not learning-log.md) to avoid contention with
  // the lock_domain tool. The PreCompact shell hook writes to the same file.
  const { system, note = "Manually recorded compaction marker." } = args;

  if (!system) {
    throw new Error("Missing required field: system.");
  }

  const dir = await ensureSystemExists(system);

  const timestamp = isoTimestamp();
  const entry = buildCompactionMarker(timestamp, note);

  const markersPath = path.join(dir, "compaction-markers.md");
  await ensureFileExists(
    markersPath,
    `# ${system} — Compaction Markers\n\n**Purpose:** Track auto-compaction events that fired during teaching sessions for this system. Each marker indicates a moment when context was compressed and may have lost detail. Phase 0.1 of the system-explainer skill checks this file at re-engagement.\n\n**Written by:** \`hooks/pre-compact-teaching-snapshot.sh\` (auto) and the \`teaching-knowledge-base\` MCP's \`record_compaction_marker\` tool (manual).\n`
  );
  await fs.appendFile(markersPath, entry);

  return {
    success: true,
    file_written: markersPath,
    timestamp,
  };
}

async function markStale(args) {
  // Marks an existing entry in context-index.md as stale by appending " *(stale)*"
  // (or a custom marker) to lines containing a matching path/identifier.
  // For gotchas.md and learning-log.md, use append-only "supersedes" notes
  // appended at the end rather than modifying past entries — those files
  // intentionally preserve their full history.
  const { system, entry_path, reason } = args;

  if (!system || !entry_path) {
    throw new Error("Missing required fields. Required: system, entry_path.");
  }

  const dir = await ensureSystemExists(system);

  const indexPath = path.join(dir, "context-index.md");
  let content;
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch {
    throw new Error(`context-index.md not found at ${indexPath}.`);
  }

  const lines = content.split("\n");
  const matchedLineIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    // Match if the line contains the entry_path within backticks or as a substring
    if (lines[i].includes(entry_path) && lines[i].startsWith("- ")) {
      matchedLineIdxs.push(i);
    }
  }

  if (matchedLineIdxs.length === 0) {
    throw new Error(
      `No entry found in context-index.md matching "${entry_path}". Check the exact text used in the entry.`
    );
  }
  if (matchedLineIdxs.length > 1) {
    throw new Error(
      `Multiple entries match "${entry_path}" (lines ${matchedLineIdxs.map((i) => i + 1).join(", ")}). Provide a more specific identifier.`
    );
  }

  const lineIdx = matchedLineIdxs[0];
  // Skip if already marked stale
  if (lines[lineIdx].includes("*(stale)*") || lines[lineIdx].includes("*(superseded)*")) {
    return {
      success: true,
      file_written: indexPath,
      note: "Entry already marked as stale; no change made.",
      line: lines[lineIdx],
    };
  }

  const staleMarker = reason
    ? ` *(stale — ${reason})*`
    : ` *(stale)*`;
  lines[lineIdx] = lines[lineIdx] + staleMarker;

  await fs.writeFile(indexPath, lines.join("\n"));

  return {
    success: true,
    file_written: indexPath,
    line_modified: lineIdx + 1,
    new_line: lines[lineIdx],
  };
}

// Directory names under `dir`, or null when `dir` cannot be read.
async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
}

async function listSystems() {
  const systems = await listDirs(REFERENCES_BASE);
  const legacySystems = await listDirs(LEGACY_REFERENCES_BASE);
  const result = { systems: systems ?? [] };
  if (legacySystems) result.legacy_systems = legacySystems;
  result.references_base = REFERENCES_BASE;
  result.legacy_base = LEGACY_REFERENCES_BASE;
  if (!systems) result.note = "References base directory not found.";
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool catalog
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "append_gotcha",
    description:
      "Append a structured gotcha entry to a system's gotchas.md. Enforces consistent schema: category, severity, files, code quote, explanation, SME question. Use this instead of editing gotchas.md directly to prevent format drift across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        system: {
          type: "string",
          description:
            "System name matching the references/<system>/ directory (e.g., 'acme-billing').",
        },
        domain: {
          type: "string",
          description:
            "The domain or feature the gotcha relates to (e.g., 'Ledger Balance', 'Batch Reconciliation').",
        },
        title: {
          type: "string",
          description: "Short title for the gotcha (under 80 characters).",
        },
        category: {
          type: "string",
          enum: VALID_GOTCHA_CATEGORIES,
          description:
            "Category of gotcha. Must be one of: Non-obvious behavior, Edge case, Design ambiguity, Possible bug, SME question.",
        },
        severity: {
          type: "string",
          enum: VALID_SEVERITIES,
          description: "Severity (High, Medium, Low). Defaults to Medium.",
        },
        files: {
          type: ["array", "string"],
          description: "File path(s) the gotcha involves. Array or comma-separated string.",
        },
        code_quote: {
          type: "string",
          description:
            "Verbatim quote of the relevant code with file:line references. Do not paraphrase.",
        },
        why_gotcha: {
          type: "string",
          description:
            "One paragraph explaining why this is a gotcha — what's surprising, ambiguous, or worth questioning.",
        },
        sme_question: {
          type: "string",
          description:
            "Specific, answerable question for a subject-matter expert or to address in the build phase. NOT generic.",
        },
      },
      required: ["system", "domain", "title", "category", "code_quote", "why_gotcha", "sme_question"],
    },
  },
  {
    name: "lock_domain",
    description:
      "Append a structured domain entry to a system's learning-log.md when a Phase 2 teaching cycle locks (or partially locks) a domain. Enforces consistent schema: entities, mental model, corrections, references, outstanding items.",
    inputSchema: {
      type: "object",
      properties: {
        system: {
          type: "string",
          description: "System name matching the references/<system>/ directory.",
        },
        name: {
          type: "string",
          description: "Domain name (e.g., 'Payouts', 'Customer Relationship').",
        },
        status: {
          type: "string",
          enum: VALID_DOMAIN_STATUSES,
          description:
            "Domain status. One of: LOCKED, PARTIALLY LOCKED, TAUGHT (with open questions), RECOMMENDATION, NOT STARTED.",
        },
        entities_taught: {
          type: "string",
          description: "Comma-separated list of entities taught in this domain.",
        },
        mental_model: {
          type: "string",
          description:
            "Multi-line markdown describing the locked mental model (bullet points or paragraphs).",
        },
        corrections: {
          type: ["array", "string"],
          description:
            "Array of corrections that surfaced during teaching (each as a string). Or a single string for one correction.",
        },
        reference_files: {
          type: ["array", "string"],
          description:
            "Reference files for this domain (e.g., 'entities.md', 'gotchas.md (Ledger Balance section)'). Array or comma-separated.",
        },
        outstanding: {
          type: "string",
          description:
            "What remains outstanding for this domain. Defaults to 'none for this domain' if omitted.",
        },
        covered: {
          type: ["array", "string"],
          description:
            "Optional. For PARTIALLY LOCKED or TAUGHT statuses: what's been covered so far in this domain. Bulleted list.",
        },
        not_yet_covered: {
          type: ["array", "string"],
          description:
            "Optional. For PARTIALLY LOCKED status: what remains uncovered in this domain. Bulleted list.",
        },
        open_questions: {
          type: ["array", "string"],
          description:
            "Optional. For TAUGHT (with open questions) status: the specific open questions that surfaced. Bulleted list. Each should also be logged in gotchas.md via append_gotcha.",
        },
        build_implication: {
          type: "string",
          description:
            "Optional. For RECOMMENDATION status: the implication this recommendation has for the build phase. Single paragraph.",
        },
      },
      required: ["system", "name", "status", "entities_taught", "mental_model"],
    },
  },
  {
    name: "add_context_entry",
    description:
      "Append a structured entry to a system's context-index.md under a specified section. Use this when new context surfaces during an engagement (new docs, meeting recordings, vendor handoffs, etc.). The section name is matched case-insensitively.",
    inputSchema: {
      type: "object",
      properties: {
        system: {
          type: "string",
          description: "System name matching the references/<system>/ directory.",
        },
        section: {
          type: "string",
          description:
            "Section header text to match (case-insensitive substring match). E.g., 'User-maintained planning', 'Meeting / feedback', 'Vendor / third-party', 'Domain references'.",
        },
        entry_path: {
          type: "string",
          description:
            "The path or identifier being catalogued (file path, URL, or short identifier).",
        },
        description: {
          type: "string",
          description: "One-line description of what this entry contains or covers.",
        },
        status: {
          type: "string",
          description:
            "Status of the entry. 'active' (default), 'stale', 'pending', or any custom marker.",
        },
      },
      required: ["system", "section", "entry_path", "description"],
    },
  },
  {
    name: "record_compaction_marker",
    description:
      "Manually record a compaction marker in a system's compaction-markers.md. Complements the automatic PreCompact hook for cases where the hook may have missed (e.g., session boundary, manual context reset).",
    inputSchema: {
      type: "object",
      properties: {
        system: {
          type: "string",
          description: "System name matching the references/<system>/ directory.",
        },
        note: {
          type: "string",
          description:
            "Optional note explaining why this marker was recorded. Defaults to a generic message.",
        },
      },
      required: ["system"],
    },
  },
  {
    name: "mark_stale",
    description:
      "Mark an existing entry in a system's context-index.md as stale (e.g., a vendor doc that's been superseded, a path that no longer exists, a reference that's been replaced). The entry text remains in the file with a *(stale)* annotation appended. For gotchas.md or learning-log.md, do NOT use this — those files are append-only by design; add a new entry that supersedes the old one instead.",
    inputSchema: {
      type: "object",
      properties: {
        system: {
          type: "string",
          description: "System name matching the references/<system>/ directory.",
        },
        entry_path: {
          type: "string",
          description:
            "The path or identifier of the entry to mark stale. Matched as a substring in the line. Must be unique enough to identify a single line.",
        },
        reason: {
          type: "string",
          description:
            "Optional short explanation of why this entry is stale. Appended in parentheses.",
        },
      },
      required: ["system", "entry_path"],
    },
  },
  {
    name: "list_systems",
    description:
      "List all systems that have knowledge base directories under references/. Useful for verifying a system exists before attempting writes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// Tool failures are reported as isError content, never as JSON-RPC errors.
async function callTool({ name, arguments: args = {} } = {}) {
  try {
    let result;
    switch (name) {
      case "append_gotcha":
        result = await appendGotcha(args);
        break;
      case "lock_domain":
        result = await lockDomain(args);
        break;
      case "add_context_entry":
        result = await addContextEntry(args);
        break;
      case "record_compaction_marker":
        result = await recordCompactionMarker(args);
        break;
      case "mark_stale":
        result = await markStale(args);
        break;
      case "list_systems":
        result = await listSystems();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP stdio transport: newline-delimited JSON-RPC 2.0 on stdin/stdout
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// stdout carries JSON-RPC only; diagnostics go to stderr.
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handleRequest({ method, params = {} }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "teaching-knowledge-base", version: "3.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

async function onLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  // Not a request (a response, or malformed): nothing to answer.
  if (!message || typeof message !== "object" || typeof message.method !== "string") return;
  // Notifications (no id), e.g. notifications/initialized: never answered.
  if (message.id === undefined) return;
  try {
    send({ jsonrpc: "2.0", id: message.id, result: await handleRequest(message) });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: error.code ?? -32603, message: error.message },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

// Graceful shutdown — log to stderr (visible in Claude Code's MCP debugging output)
// but never crash with an unhandled exception that loses in-flight writes.
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("uncaughtException", (err) => {
  process.stderr.write(`teaching-knowledge-base: uncaught exception: ${err.message}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`teaching-knowledge-base: unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});

// When stdin closes the interface closes; in-flight writes finish, then the
// process exits on its own (nothing else keeps the event loop alive).
readline
  .createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    if (line.trim()) onLine(line);
  });
