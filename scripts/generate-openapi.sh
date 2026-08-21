#!/usr/bin/env bash
set -euo pipefail

# OpenAPI generation pipeline
# Generates TypeScript-fetch clients from backend OpenAPI specs.
#
# Usage:
#   ./scripts/generate-openapi.sh                    # Generate all SDK modules
#   ./scripts/generate-openapi.sh --module security  # Generate only the specified module
#
# Valid module names: security, order, inventory, workorder, accounting, catalog, customer,
#   invoice, location, people, price, shop-manager, image, event-receiver, vehicle-fitment,
#   vehicle-inventory, internal, documents, inquiry, bulk-loader

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

MODULES=(security order inventory workorder accounting catalog customer invoice location people people-contact price shop-manager image event-receiver vehicle-fitment vehicle-inventory internal documents inquiry bulk-loader marketing mcp-server supplier warranty)

patch_package_tsconfig() {
	local pkg="$1"
	local tsconfig="packages/sdk-${pkg}/tsconfig.json"
	local tsconfig_esm="packages/sdk-${pkg}/tsconfig.esm.json"
	local pkg_json="packages/sdk-${pkg}/package.json"
	# The generator pins typescript ^4.0, which predates the moduleResolution
	# "bundler" setting used by the esm build; align with the workspace pin.
	if [[ -f "$pkg_json" ]]; then
		sed -i 's/"typescript": "\^4[^"]*"/"typescript": "~5.9.3"/' "$pkg_json"
	fi
	# The generator emits legacy settings (target es6, module commonjs,
	# moduleResolution node) and its esm variant inherits moduleResolution,
	# which TS 5.x rejects when paired with a non-Node16 module (TS5110).
	# Rewrite both configs to the combos the workspace standardizes on:
	# CJS build = NodeNext/NodeNext, ESM build = ESNext + bundler.
	if [[ -f "$tsconfig" ]]; then
		node -e '
			const fs = require("fs");
			const file = process.argv[1];
			const t = JSON.parse(fs.readFileSync(file, "utf8"));
			t.compilerOptions.target = "ES2022";
			t.compilerOptions.module = "NodeNext";
			t.compilerOptions.moduleResolution = "NodeNext";
			t.compilerOptions.rootDir = t.compilerOptions.rootDir || "src";
			t.compilerOptions.skipLibCheck = true;
			delete t.compilerOptions.typeRoots;
			fs.writeFileSync(file, JSON.stringify(t, null, 2) + "\n");
		' "$tsconfig"
	fi
	if [[ -f "$tsconfig_esm" ]]; then
		node -e '
			const fs = require("fs");
			const file = process.argv[1];
			const t = JSON.parse(fs.readFileSync(file, "utf8"));
			t.compilerOptions.module = "ESNext";
			t.compilerOptions.moduleResolution = "bundler";
			fs.writeFileSync(file, JSON.stringify(t, null, 2) + "\n");
		' "$tsconfig_esm"
	fi
}

cleanup_vehicle_inventory_duplicate_exports() {
	# Post-generation cleanup: VehicleAPIApi defines request-parameter interfaces named
	# CreateVehicleRequest and UpdateVehicleRequest that clash with same-named model DTOs
	# (TS2308 ambiguity). Drop `export` from the API-level interfaces so models win.
	echo "[generate] Applying sdk-vehicle-inventory duplicate-export cleanup..."
	VEHICLE_API_FILE="packages/sdk-vehicle-inventory/src/apis/VehicleAPIApi.ts"

	if [[ -f "$VEHICLE_API_FILE" ]]; then
		sed -i 's/^export interface CreateVehicleRequest {/interface CreateVehicleRequest {/;s/^export interface UpdateVehicleRequest {/interface UpdateVehicleRequest {/' "$VEHICLE_API_FILE"
		echo "[generate] Patched VehicleAPIApi.ts to un-export CreateVehicleRequest and UpdateVehicleRequest"
	fi
}

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
		sed -i '/CycleCountAPIApi/d' "$INVENTORY_INDEX_FILE"
		echo "[generate] Patched apis/index.ts to remove CycleCountAPIApi export"
	fi
}

cleanup_accounting_duplicate_exports() {
	# Post-generation cleanup: FinancialReportingApi and FinancialReportingForTaxLiabilityApi
	# both export identical TaxLiability request-parameter interfaces, which makes the
	# `export *` barrel in apis/index.ts ambiguous (TS2308). Drop `export` from the
	# duplicates in the tax-liability API so FinancialReportingApi's exports win.
	echo "[generate] Applying sdk-accounting duplicate-export cleanup..."
	TAX_API_FILE="packages/sdk-accounting/src/apis/FinancialReportingForTaxLiabilityApi.ts"

	if [[ -f "$TAX_API_FILE" ]]; then
		sed -i 's/^export interface FreezeTaxLiabilitySnapshotRequest {/interface FreezeTaxLiabilitySnapshotRequest {/;s/^export interface GetTaxLiabilitySnapshotRequest {/interface GetTaxLiabilitySnapshotRequest {/;s/^export interface ListTaxLiabilitySnapshotsRequest {/interface ListTaxLiabilitySnapshotsRequest {/;s/^export interface VerifyTaxLiabilitySnapshotRequest {/interface VerifyTaxLiabilitySnapshotRequest {/' "$TAX_API_FILE"
		echo "[generate] Patched FinancialReportingForTaxLiabilityApi.ts to un-export duplicate TaxLiability request interfaces"
	fi
}

# ---------------------------------------------------------------------------
# Protected-file guard
#
# Commit 33507b5 ("Regenerated from latest openapi changes") let the generator
# overwrite hand-maintained files - the src/index.ts factories, package.json,
# README banners and tsconfigs - and the breakage went unnoticed for months.
# Each package now carries real rules in its .openapi-generator-ignore; this
# guard is the tripwire that proves they held. It hashes the protected files
# before generation and fails the run if any of them changed.
# ---------------------------------------------------------------------------

PROTECTED_RELPATHS=(
	"src/index.ts"
	"package.json"
	"README.md"
	"tsconfig.json"
	"tsconfig.esm.json"
	".openapi-generator-ignore"
)

PROTECTED_SNAPSHOT=""

protected_paths() {
	local m path
	for m in "${MODULES[@]}"; do
		for path in "${PROTECTED_RELPATHS[@]}"; do
			[[ -f "packages/sdk-${m}/${path}" ]] && echo "packages/sdk-${m}/${path}"
		done
	done
	# Hand-written validator living inside an otherwise generated model.
	[[ -f packages/sdk-customer/src/models/VehicleSummary.ts ]] && \
		echo packages/sdk-customer/src/models/VehicleSummary.ts
	return 0
}

snapshot_protected() {
	PROTECTED_SNAPSHOT="$(mktemp)"
	protected_paths | while read -r f; do
		printf '%s  %s\n' "$(git hash-object "$f")" "$f"
	done > "$PROTECTED_SNAPSHOT"
}

verify_protected() {
	[[ -n "$PROTECTED_SNAPSHOT" && -f "$PROTECTED_SNAPSHOT" ]] || return 0
	local changed=() hash f now
	while read -r hash f; do
		[[ -z "$f" ]] && continue
		if [[ ! -f "$f" ]]; then
			changed+=("$f (deleted)")
			continue
		fi
		now="$(git hash-object "$f")"
		[[ "$now" != "$hash" ]] && changed+=("$f")
	done < "$PROTECTED_SNAPSHOT"
	rm -f "$PROTECTED_SNAPSHOT"

	if (( ${#changed[@]} > 0 )); then
		echo "" >&2
		echo "[generate] ERROR: the generator modified hand-maintained files:" >&2
		printf '  %s\n' "${changed[@]}" >&2
		echo "" >&2
		echo "  These are listed in the package's .openapi-generator-ignore and must" >&2
		echo "  survive regeneration. Restore them with:" >&2
		echo "" >&2
		printf '    git checkout -- %s\n' "${changed[@]}" >&2
		echo "" >&2
		echo "  Then fix the ignore rules before re-running. See the Durion block in" >&2
		echo "  packages/sdk-<module>/.openapi-generator-ignore." >&2
		return 1
	fi
	echo "[generate] Protected files intact."
	return 0
}

snapshot_protected

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
	npx @openapitools/openapi-generator-cli generate --generator-key "sdk-${module}"

	patch_package_tsconfig "$module"
	if [[ "$module" == "accounting" ]]; then
		cleanup_accounting_duplicate_exports
	fi
	if [[ "$module" == "inventory" ]]; then
		cleanup_inventory_duplicate_exports
	fi
	if [[ "$module" == "vehicle-inventory" ]]; then
		cleanup_vehicle_inventory_duplicate_exports
	fi
else
	# Generate all SDK modules in deterministic order
	for m in "${MODULES[@]}"; do
		echo "Generating sdk-${m}..."
		npx @openapitools/openapi-generator-cli generate --generator-key "sdk-${m}"

		patch_package_tsconfig "$m"
		if [[ "$m" == "accounting" ]]; then
			cleanup_accounting_duplicate_exports
		fi
		if [[ "$m" == "inventory" ]]; then
			cleanup_inventory_duplicate_exports
		fi
		if [[ "$m" == "vehicle-inventory" ]]; then
			cleanup_vehicle_inventory_duplicate_exports
		fi
	done
fi

verify_protected

echo "Generation complete."
