#!/usr/bin/env bash
set -euo pipefail

# OpenAPI generation pipeline
# Generates TypeScript-fetch clients from backend OpenAPI specs.
#
# Usage:
#   ./scripts/generate.sh                    # Generate all SDK modules
#   ./scripts/generate.sh --module security  # Generate only the specified module
#
# Valid module names: security, order, inventory, workorder, accounting, catalog, customer, invoice, location, people, price, shop-manager, image, event-receiver, vehicle-fitment, vehicle-inventory

module=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--module)
			module="$2"
			shift 2
			;;
		*)
			echo "Unknown argument: $1" >&2
			exit 2
			;;
	esac
done

MODULES=(security order inventory workorder accounting catalog customer invoice location people price shop-manager image event-receiver vehicle-fitment vehicle-inventory)

cleanup_inventory_duplicate_exports() {
	# Post-generation cleanup: fix sdk-inventory duplicate exports caused by multi-tag ops
	echo "[generate] Applying sdk-inventory duplicate-export cleanup..."
	INVENTORY_APIS_DIR="packages/sdk-inventory/src/apis"
	CYCLECOUNT_API_FILE="${INVENTORY_APIS_DIR}/CycleCountAPIApi.ts"
	INVENTORY_INDEX_FILE="${INVENTORY_APIS_DIR}/index.ts"

	if [[ -f "$CYCLECOUNT_API_FILE" ]]; then
		rm -f "$CYCLECOUNT_API_FILE"
		echo "[generate] Removed CycleCountAPIApi.ts (duplicate catch-all)"
	fi

	if [[ -f "$INVENTORY_INDEX_FILE" ]]; then
		# Remove the CycleCountAPIApi export line
		sed -i '/CycleCountAPIApi/d' "$INVENTORY_INDEX_FILE"
		echo "[generate] Patched apis/index.ts to remove CycleCountAPIApi export"
	fi
}

if [[ -n "$module" ]]; then
	# Validate the provided module name
	valid=false
	for m in "${MODULES[@]}"; do
		if [[ "$m" == "$module" ]]; then
			valid=true
			break
		fi
	done
	if [[ "$valid" == "false" ]]; then
		echo "Invalid --module value: '$module'. Valid modules: ${MODULES[*]}" >&2
		exit 2
	fi
	echo "Generating sdk-${module}..."
	npx openapi-generator-cli generate --generator-key "sdk-${module}"

	if [[ "$module" == "inventory" ]]; then
		cleanup_inventory_duplicate_exports
	fi
else
	# Generate all SDK modules in deterministic order
	for m in "${MODULES[@]}"; do
		echo "Generating sdk-${m}..."
		npx openapi-generator-cli generate --generator-key "sdk-${m}"

		if [[ "$m" == "inventory" ]]; then
			cleanup_inventory_duplicate_exports
		fi
	done
fi

echo "Generation complete."