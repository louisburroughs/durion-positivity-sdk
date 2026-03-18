#!/usr/bin/env bash
set -euo pipefail
# diff-contracts.sh - Compare operationId sets between two snapshot directories.
#
# Usage:
#   ./scripts/diff-contracts.sh --previous <snapshot-dir> --current <packages-dir>
#   ./scripts/diff-contracts.sh --previous <snapshot-dir> --current <packages-dir> --output <file>
#
# Extracts operationId references from all src/apis/*.ts files under each dir.
# Prints:
#   ADDED: <id>   -- in current, not in previous
#   REMOVED: <id> -- in previous, not in current
# Exits 0 on clean diff, 1 on argument/filesystem error.

PREVIOUS_DIR=""
CURRENT_DIR=""
OUTPUT_FILE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --previous)
      PREVIOUS_DIR="$2"
      shift 2
      ;;
    --current)
      CURRENT_DIR="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Validate required arguments
if [[ -z "$PREVIOUS_DIR" ]]; then
  echo "Error: --previous <snapshot-dir> is required" >&2
  exit 1
fi
if [[ -z "$CURRENT_DIR" ]]; then
  echo "Error: --current <packages-dir> is required" >&2
  exit 1
fi

# Extract operationIds from a directory tree
# Looks for: // operationId: <id>  pattern in src/apis/*.ts files
extract_operation_ids() {
  local dir="$1"
  grep -rh "// operationId:" "$dir" 2>/dev/null \
    | sed 's/.*\/\/ operationId: *//' \
    | tr -d '\r' \
    | sort -u
}

# Handle absent --previous directory (first run; all current ops are ADDED)
if [[ ! -d "$PREVIOUS_DIR" ]]; then
  output=""
  while IFS= read -r op_id; do
    [[ -z "$op_id" ]] && continue
    output+="ADDED: ${op_id}"$'\n'
  done < <(extract_operation_ids "$CURRENT_DIR")

  if [[ -n "$OUTPUT_FILE" ]]; then
    printf '%s' "$output" > "$OUTPUT_FILE"
  else
    printf '%s' "$output"
  fi
  exit 0
fi

# Validate current directory exists
if [[ ! -d "$CURRENT_DIR" ]]; then
  echo "Error: --current directory not found: $CURRENT_DIR" >&2
  exit 1
fi

# Extract operation ID sets
prev_ids=$(extract_operation_ids "$PREVIOUS_DIR")
curr_ids=$(extract_operation_ids "$CURRENT_DIR")

# Compute ADDED (in current, not in previous)
# Compute REMOVED (in previous, not in current)
output=""

while IFS= read -r op_id; do
  [[ -z "$op_id" ]] && continue
  if ! echo "$prev_ids" | grep -qxF "$op_id"; then
    output+="ADDED: ${op_id}"$'\n'
  fi
done <<< "$curr_ids"

while IFS= read -r op_id; do
  [[ -z "$op_id" ]] && continue
  if ! echo "$curr_ids" | grep -qxF "$op_id"; then
    output+="REMOVED: ${op_id}"$'\n'
  fi
done <<< "$prev_ids"

# Output results
if [[ -n "$OUTPUT_FILE" ]]; then
  printf '%s' "$output" > "$OUTPUT_FILE"
else
  printf '%s' "$output"
fi

exit 0
