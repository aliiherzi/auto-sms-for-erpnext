#!/usr/bin/env bash
# Auto SMS for ERPNext – server installer (Ubuntu/Debian, e.g. a Hostinger VPS).
#
#   sudo bash install.sh            install or update, then start
#   sudo bash install.sh --no-build start with an image that is already built
#
# Safe to run again: it keeps your .env and data, and only rebuilds and restarts.
set -euo pipefail

cd "$(dirname "$0")"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run it as root: sudo bash install.sh"

# 1. Docker -------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (official script from get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose is missing. Install the docker-compose-plugin package and run this again."

# 2. Settings file ----------------------------------------------------------------
random() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
set_env() { # set_env KEY VALUE  (replace or append in .env)
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
NEW_PASSWORD=""
if [[ ! -f .env ]]; then
  say "Creating .env"
  cp .env.example .env
  NEW_PASSWORD="$(random 20)"
  set_env ADMIN_PASSWORD "$NEW_PASSWORD"
  set_env WEBHOOK_SECRET "$(random 32)"
  TZ_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  [[ -n "$TZ_NAME" ]] && set_env TZ "$TZ_NAME"
  chmod 600 .env
fi
grep -qE '^ADMIN_PASSWORD=change-this-password$' .env && die "Set a real ADMIN_PASSWORD in .env first."

# 3. Port ---------------------------------------------------------------------------
PUBLIC_PORT="$(grep -E '^PUBLIC_PORT=' .env | cut -d= -f2 || true)"
PUBLIC_PORT="${PUBLIC_PORT:-3000}"
port_used_by_others() { # true when another program already listens on the port
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  ! docker ps --format '{{.Names}} {{.Ports}}' | grep -q "auto-sms-for-erpnext.*:$1->"
}
if port_used_by_others "$PUBLIC_PORT"; then
  for candidate in $(seq 3001 3020); do
    if ! port_used_by_others "$candidate"; then
      warn "Port $PUBLIC_PORT is taken by another program; using $candidate instead."
      PUBLIC_PORT="$candidate"
      break
    fi
  done
fi
set_env PUBLIC_PORT "$PUBLIC_PORT"

# 4. Start ---------------------------------------------------------------------------
if [[ $BUILD -eq 1 ]]; then
  say "Building and starting (the first time takes a few minutes)…"
  docker compose up -d --build
else
  say "Starting…"
  docker compose up -d
fi

say "Waiting for the dashboard…"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PUBLIC_PORT/healthz" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[[ "${READY:-0}" == 1 ]] || die "The service did not start. See: docker compose logs --tail 50"

# 5. Done ------------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
BIND="$(grep -E '^BIND_ADDRESS=' .env | cut -d= -f2 || true)"
say "Auto SMS for ERPNext is running."
if [[ "${BIND:-0.0.0.0}" == "127.0.0.1" ]]; then
  echo "   Dashboard (only on this server): http://127.0.0.1:$PUBLIC_PORT – reach it through your HTTPS proxy."
else
  echo "   Dashboard: http://${IP:-your-server-ip}:$PUBLIC_PORT"
fi
if [[ -n "$NEW_PASSWORD" ]]; then
  echo "   Password:  $NEW_PASSWORD"
  echo "   (also saved in $(pwd)/.env as ADMIN_PASSWORD)"
fi
echo
echo "   Next: open the dashboard → Settings → ERPNext connection, then Overview → scan the QR code with WhatsApp."
warn "This address uses plain http. For daily use, give it a name with HTTPS (see README → 'Your own web address')."
