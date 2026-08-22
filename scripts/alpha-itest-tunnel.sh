#!/usr/bin/env bash
#
# Opens AWS SSM port-forwarding tunnels from this machine to the alpha EC2 host
# so packages/sdk-integration-tests can run against alpha from a laptop.
#
# Mechanism (BACKEND_INTERACTION_TEST_SPEC.md, Task 7 Step 1): the alpha stack's
# base docker-compose.yml already publishes both target services on the EC2 host
# (pos-api-gateway 8080:8080, pos-security-service 8086:8080), so this uses the
# AWS-owned AWS-StartPortForwardingSession document against instance-local ports.
# The ...ToRemoteHost variant and a loopback-only Compose publish are both
# unnecessary. No security-group ingress is opened and nothing on alpha changes.
#
# Usage:
#   ./scripts/alpha-itest-tunnel.sh
#   ALPHA_INSTANCE_ID=i-0123456789abcdef0 ./scripts/alpha-itest-tunnel.sh
#
# Environment overrides:
#   ALPHA_INSTANCE_ID           skip the tag lookup and use this instance
#   ALPHA_REGION                default us-east-1
#   ITEST_GATEWAY_LOCAL_PORT    default 18080
#   ITEST_SECURITY_LOCAL_PORT   default 18086
#   ALPHA_DB_LOCAL_PORT         default 15432 (only with --with-db)
#
# Flags:
#   --with-db   also forward alpha's PostgreSQL. The container publishes
#               127.0.0.1:5432 on the EC2 host, which is exactly what SSM
#               reaches, so no ingress and no SSH is involved. Credentials
#               are POSTGRES_USER / POSTGRES_PASSWORD in /opt/durion/alpha/.env
#               on the host - this script never reads or transports them.
#
# Ctrl-C shuts both sessions down.

set -euo pipefail

WITH_DB=false
for arg in "$@"; do
	case "$arg" in
		--with-db) WITH_DB=true ;;
		-h|--help) sed -n '2,40p' "$0"; exit 0 ;;
		*) echo "error: unknown argument '$arg' (try --help)" >&2; exit 2 ;;
	esac
done

REGION="${ALPHA_REGION:-us-east-1}"
DB_REMOTE_PORT=5432
DB_LOCAL_PORT="${ALPHA_DB_LOCAL_PORT:-15432}"
GATEWAY_REMOTE_PORT=8080
SECURITY_REMOTE_PORT=8086
GATEWAY_LOCAL_PORT="${ITEST_GATEWAY_LOCAL_PORT:-18080}"
SECURITY_LOCAL_PORT="${ITEST_SECURITY_LOCAL_PORT:-18086}"

PIDS=()
LOG_DIR=""

die() {
  echo "error: $*" >&2
  exit 1
}

# `aws ssm start-session` execs session-manager-plugin as a child and does NOT
# forward SIGTERM to it. Killing only the aws pid leaves the plugin orphaned,
# still holding the SSM session and the local port. Collect descendants while
# the parent is alive, then kill the whole family.
kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  if [[ ${#PIDS[@]} -gt 0 ]]; then
    echo ""
    echo "Closing tunnel sessions..."
    for pid in "${PIDS[@]}"; do
      kill_tree "$pid"
    done
    wait 2>/dev/null || true
    # Escalate to SIGKILL for anything that ignored SIGTERM.
    for pid in "${PIDS[@]}"; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
  [[ -n "$LOG_DIR" ]] && rm -rf "$LOG_DIR"
}
trap cleanup INT TERM EXIT

# ---- Preflight -------------------------------------------------------------

command -v aws >/dev/null 2>&1 || die \
  "AWS CLI not found. Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"

command -v session-manager-plugin >/dev/null 2>&1 || die \
  "session-manager-plugin not found. SSM port forwarding needs it. Install: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"

aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || die \
  "No usable AWS credentials for region $REGION. Configure a profile/role with ssm:StartSession on the alpha instance, then retry."

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && { exec 3<&- 3>&-; return 0; }
  return 1
}

PREFLIGHT_PORTS=("$GATEWAY_LOCAL_PORT" "$SECURITY_LOCAL_PORT")
[[ "$WITH_DB" == "true" ]] && PREFLIGHT_PORTS+=("$DB_LOCAL_PORT")

for port in "${PREFLIGHT_PORTS[@]}"; do
  if port_in_use "$port"; then
    die "Local port $port is already in use (an older tunnel still running?). Close it or set ITEST_GATEWAY_LOCAL_PORT / ITEST_SECURITY_LOCAL_PORT."
  fi
done

# ---- Resolve the alpha instance -------------------------------------------

if [[ -n "${ALPHA_INSTANCE_ID:-}" ]]; then
  INSTANCE_ID="$ALPHA_INSTANCE_ID"
  echo "Using ALPHA_INSTANCE_ID=$INSTANCE_ID"
else
  echo "Resolving alpha instance by tag (Project=durion, Environment=alpha)..."
  INSTANCE_ID="$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters \
      "Name=tag:Project,Values=durion" \
      "Name=tag:Environment,Values=alpha" \
      "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text 2>/dev/null)" || die \
    "ec2:DescribeInstances failed. Check credentials and permissions, or set ALPHA_INSTANCE_ID to skip the lookup."

  # describe-instances prints tab-separated ids; normalise to words.
  read -r -a FOUND <<< "$INSTANCE_ID"
  case ${#FOUND[@]} in
    0) die "No running instance tagged Project=durion, Environment=alpha in $REGION. Set ALPHA_INSTANCE_ID explicitly." ;;
    1) INSTANCE_ID="${FOUND[0]}" ;;
    *) die "Tag lookup matched ${#FOUND[@]} running instances (${FOUND[*]}). Set ALPHA_INSTANCE_ID to pick one." ;;
  esac
  echo "Resolved alpha instance: $INSTANCE_ID"
fi

# Distinguish "the caller may not ask" from "the instance is not managed" - they
# need completely different fixes, and swallowing stderr makes a denial look
# like a broken SSM agent.
PING_ERR="$(mktemp)"
PING_STATUS="$(aws ssm describe-instance-information \
  --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text 2>"$PING_ERR")" || PING_STATUS=""

if grep -q 'AccessDenied\|not authorized' "$PING_ERR" 2>/dev/null; then
  CALLER="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo '(unknown)')"
  rm -f "$PING_ERR"
  die "Not authorized to call ssm:DescribeInstanceInformation as $CALLER.
  This is a permissions problem, not a broken SSM agent. The identity needs
  ssm:DescribeInstanceInformation and ssm:StartSession on $INSTANCE_ID.
  If you use a separate profile for alpha, set AWS_PROFILE before running."
fi
rm -f "$PING_ERR"

if [[ "$PING_STATUS" != "Online" ]]; then
  die "Instance $INSTANCE_ID is not an Online SSM managed node (ping status: ${PING_STATUS:-None}). Check the SSM agent, the instance profile (AmazonSSMManagedInstanceCore), and outbound 443 to the ssm/ssmmessages/ec2messages endpoints."
fi

# ---- Open both forwarding sessions ----------------------------------------

LOG_DIR="$(mktemp -d)"

start_forward() {
  local label="$1" remote_port="$2" local_port="$3" log="$4"
  aws ssm start-session \
    --target "$INSTANCE_ID" \
    --region "$REGION" \
    --document-name AWS-StartPortForwardingSession \
    --parameters "portNumber=$remote_port,localPortNumber=$local_port" \
    >"$log" 2>&1 &
  PIDS+=("$!")
  echo "  $label: localhost:$local_port -> $INSTANCE_ID:$remote_port (pid $!)"
}

wait_ready() {
  local label="$1" pid="$2" log="$3" waited=0
  while (( waited < 30 )); do
    if grep -q 'Waiting for connections' "$log" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "error: $label session exited before it was ready:" >&2
      sed 's/^/  /' "$log" >&2
      if grep -qi 'AccessDenied\|not authorized\|is not authorized' "$log" 2>/dev/null; then
        echo "" >&2
        echo "  This looks like an IAM denial. The calling identity needs ssm:StartSession on both:" >&2
        echo "    arn:aws:ec2:$REGION:<account>:instance/$INSTANCE_ID" >&2
        echo "    arn:aws:ssm:$REGION::document/AWS-StartPortForwardingSession" >&2
      fi
      return 1
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  echo "error: $label session did not report ready within 30s:" >&2
  sed 's/^/  /' "$log" >&2
  return 1
}

echo ""
echo "Opening SSM port-forwarding sessions..."
start_forward "pos-api-gateway     " "$GATEWAY_REMOTE_PORT"  "$GATEWAY_LOCAL_PORT"  "$LOG_DIR/gateway.log"
GATEWAY_PID="${PIDS[-1]}"
start_forward "pos-security-service" "$SECURITY_REMOTE_PORT" "$SECURITY_LOCAL_PORT" "$LOG_DIR/security.log"
SECURITY_PID="${PIDS[-1]}"

if [[ "$WITH_DB" == "true" ]]; then
	start_forward "postgres           " "$DB_REMOTE_PORT" "$DB_LOCAL_PORT" "$LOG_DIR/postgres.log"
	DB_PID="${PIDS[-1]}"
fi

wait_ready "pos-api-gateway" "$GATEWAY_PID" "$LOG_DIR/gateway.log" || exit 1
wait_ready "pos-security-service" "$SECURITY_PID" "$LOG_DIR/security.log" || exit 1
if [[ "$WITH_DB" == "true" ]]; then
	wait_ready "postgres" "$DB_PID" "$LOG_DIR/postgres.log" || exit 1
fi

# ---- Print the exports the suite needs ------------------------------------

cat <<EXPORTS

Tunnel is up. Export these in the shell that runs the suite:

export ITEST_BASE_URL=http://localhost:$GATEWAY_LOCAL_PORT
export ITEST_SECURITY_SERVICE_URL=http://localhost:$SECURITY_LOCAL_PORT

Then:  npm run test:integration

Smoke-check:
  curl http://localhost:$GATEWAY_LOCAL_PORT/actuator/health
  curl http://localhost:$SECURITY_LOCAL_PORT/actuator/health
$(if [[ "$WITH_DB" == "true" ]]; then cat <<DB

PostgreSQL is forwarded on localhost:$DB_LOCAL_PORT. Credentials are
POSTGRES_USER / POSTGRES_PASSWORD from /opt/durion/alpha/.env on the host:

  psql -h 127.0.0.1 -p $DB_LOCAL_PORT -U <POSTGRES_USER> -d pos_people_db
DB
fi)

Traffic rides the SSM-encrypted channel; nothing is exposed publicly.
Press Ctrl-C to close all sessions.
EXPORTS

wait 2>/dev/null || true
