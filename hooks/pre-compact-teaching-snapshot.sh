#!/usr/bin/env bash
# pre-compact-teaching-snapshot.sh
#
# Fires before Claude Code compacts conversation context (manual or auto).
# Writes a timestamped compaction marker to each recently-active teaching system's
# `compaction-markers.md` file. The marker signals to a post-compaction agent that
# recent context may have been lost; Phase 0.1 of the system-explainer skill
# re-reads these markers at re-engagement.
#
# Writes go to a SEPARATE compaction-markers.md file (not learning-log.md) to
# eliminate any append-contention with the teaching-knowledge-base MCP's
# lock_domain tool.
#
# This hook intentionally does NOT use `set -e` — a hook failure should never
# block compaction. We always exit 0.
#
# IMPORTANT: the marker template below is mirrored by the buildCompactionMarker
# function in mcp/teaching-knowledge-base/index.js (the vendored MCP server).
# The two must stay byte-identical. If you change one, change both.
#
# Knowledge-base root resolution (shared with SKILL.md and the MCP server):
#   1. $SYSTEM_EXPLAINER_HOME/references         when SYSTEM_EXPLAINER_HOME is set
#   2. <git-root>/.system-explainer/references   when that directory exists
#   3. $HOME/.system-explainer/references
# The legacy root $HOME/.claude/skills/system-explainer/references is ALSO
# scanned when it exists, so pre-existing installs keep receiving markers.
#
# Triggered by: the PreCompact entry in hooks/hooks.json (plugin install), or an
#               equivalent PreCompact entry in ~/.claude/settings.json.
# Consumed by:  system-explainer skill Phase 0.1 re-engagement protocol
# Logs:         $HOME/.system-explainer/logs/pre-compact.log and
#               $HOME/.system-explainer/logs/pre-compact-failures.log

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
LOG_DIR="$HOME/.system-explainer/logs"
LOG_FILE="$LOG_DIR/pre-compact.log"
FAILURE_LOG="$LOG_DIR/pre-compact-failures.log"
LEGACY_REFERENCES_DIR="$HOME/.claude/skills/system-explainer/references"

# Consume any JSON input on stdin so we don't break the harness's pipe
cat > /dev/null 2>&1 || true

# Ensure the log directory exists for log writes (never fail if we cannot)
mkdir -p "$LOG_DIR" 2>/dev/null || true

# Log hook execution for verification
if ! echo "[$TIMESTAMP] pre-compact-teaching-snapshot.sh fired" >> "$LOG_FILE" 2>/dev/null; then
  : # silent — can't even log
fi

# Resolve the knowledge-base root (precedence in the header comment).
if [ -n "${SYSTEM_EXPLAINER_HOME:-}" ]; then
  REFERENCES_DIR="$SYSTEM_EXPLAINER_HOME/references"
else
  REFERENCES_DIR="$HOME/.system-explainer/references"
  if git_root=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null) \
     && [ -d "$git_root/.system-explainer/references" ]; then
    REFERENCES_DIR="$git_root/.system-explainer/references"
  fi
fi

# Roots to scan: the resolved root, plus the legacy root when it exists and differs.
ROOTS=("$REFERENCES_DIR")
if [ -d "$LEGACY_REFERENCES_DIR" ] && [ "$LEGACY_REFERENCES_DIR" != "$REFERENCES_DIR" ]; then
  ROOTS+=("$LEGACY_REFERENCES_DIR")
fi

# Append marker to compaction-markers.md of each "recently active" teaching system.
# "Recently active" = compaction-markers.md OR learning-log.md modified in the
# last 14 days. (Using either signal lets us catch systems that haven't had a
# compaction marker yet but are actively being taught.)
for references_dir in "${ROOTS[@]}"; do
  [ -d "$references_dir" ] || continue
  for system_dir in "$references_dir"/*/; do
    learning_log="${system_dir}learning-log.md"
    markers_file="${system_dir}compaction-markers.md"

    # Only mark systems touched in the last 14 days
    recent=""
    if [ -f "$learning_log" ] && find "$learning_log" -mtime -14 -print 2>/dev/null | grep -q .; then
      recent=yes
    fi
    if [ -z "$recent" ] && [ -f "$markers_file" ] && find "$markers_file" -mtime -14 -print 2>/dev/null | grep -q .; then
      recent=yes
    fi

    if [ -n "$recent" ]; then
      # Initialize the markers file if it doesn't exist yet
      if [ ! -f "$markers_file" ]; then
        {
          echo "# $(basename "$system_dir") — Compaction Markers"
          echo ""
          echo "**Purpose:** Track auto-compaction events that fired during teaching sessions for this system. Each marker indicates a moment when context was compressed and may have lost detail. Phase 0.1 of the system-explainer skill checks this file at re-engagement."
          echo ""
          echo "**Written by:** \`hooks/pre-compact-teaching-snapshot.sh\` (auto) and the \`teaching-knowledge-base\` MCP's \`record_compaction_marker\` tool (manual)."
        } > "$markers_file" 2>/dev/null || {
          echo "[$TIMESTAMP] FAILED to initialize $markers_file" >> "$FAILURE_LOG" 2>/dev/null
          continue
        }
      fi

      # Append the marker. Must match the buildCompactionMarker template in the MCP.
      if ! {
        echo ""
        echo "---"
        echo ""
        echo "## Compaction marker — $TIMESTAMP"
        echo ""
        echo "Auto-compaction fired during an active session. Recent decisions, corrections, or in-flight reasoning may not be preserved in the post-compaction conversation summary."
        echo ""
        echo "**For the agent re-engaging:** treat this as a signal to re-read this learning log, gotchas.md, and context-index.md in full before responding. Do not produce content from compacted memory alone. If unsure about recent context, ask the user to confirm where you left off."
      } >> "$markers_file" 2>/dev/null; then
        echo "[$TIMESTAMP] FAILED to append marker to $markers_file" >> "$FAILURE_LOG" 2>/dev/null
      fi
    fi
  done
done

# Always exit 0 — hook failure must not block compaction
exit 0
