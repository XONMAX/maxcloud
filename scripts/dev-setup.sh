#!/usr/bin/env bash
# One-command local setup: infra (Docker), env files, deps, migrations, seed data.
#   pnpm dev:setup        then        pnpm dev
# Without Docker: MAXCLOUD_NO_DOCKER=1 pnpm dev:setup  (you provide Postgres, Redis and S3 yourself)
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; shift
  for arg in "$@"; do while IFS= read -r line; do printf '    %s\n' "$line" >&2; done <<<"$arg"; done
  exit 1
}
# TCP probe using bash itself: no pg_isready / redis-cli / curl needed on the host.
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_port() { # port name seconds
  for _ in $(seq 1 "$3"); do port_open "$1" && return 0; sleep 1; done
  return 1
}

# Linux distribution family, for install hints.
DISTRO=other
OS_RELEASE=${MAXCLOUD_OS_RELEASE:-/etc/os-release}
if [ -r "$OS_RELEASE" ]; then
  . "$OS_RELEASE"
  case " ${ID:-} ${ID_LIKE:-} " in
    *" fedora "*|*" rhel "*|*" centos "*) DISTRO=fedora ;;
    *" debian "*|*" ubuntu "*) DISTRO=debian ;;
    *" arch "*) DISTRO=arch ;;
  esac
fi
[ "$(uname -s)" = "Darwin" ] && DISTRO=macos

docker_install_help() {
  case "$DISTRO" in
    fedora)
      echo "sudo dnf -y install dnf-plugins-core"
      echo "sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo"
      echo "    (Fedora 40 or older: sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo)"
      echo "sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
      echo "sudo systemctl enable --now docker"
      echo "sudo usermod -aG docker \$USER      # then log out and back in (or: newgrp docker)" ;;
    debian)
      echo "Follow https://docs.docker.com/engine/install/ (Docker's apt repo), then:"
      echo "sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
      echo "sudo usermod -aG docker \$USER      # then log out and back in" ;;
    arch) echo "sudo pacman -S docker docker-compose && sudo systemctl enable --now docker && sudo usermod -aG docker \$USER" ;;
    macos) echo "Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/" ;;
    *) echo "See https://docs.docker.com/engine/install/" ;;
  esac
}

native_install_help() {
  case "$DISTRO" in
    fedora) echo "sudo dnf -y install postgresql-server redis && sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql redis" ;;
    debian) echo "sudo apt-get install -y postgresql redis-server" ;;
    arch) echo "sudo pacman -S postgresql redis" ;;
    macos) echo "brew install postgresql@16 redis" ;;
  esac
  echo "Create the role and databases: user/password/db 'maxcloud', plus db 'maxcloud_test'."
  echo "S3: go install github.com/versity/versitygw/cmd/versitygw@latest &&"
  echo "    versitygw --access maxcloud --secret maxcloud-dev-secret --port :7070 posix ./.dev-data/s3"
}

say "Infrastructure (Postgres, Redis, S3, Mailpit)"
SMTP=
if [ "${MAXCLOUD_NO_DOCKER:-}" = "1" ]; then
  echo "MAXCLOUD_NO_DOCKER=1: using services already running on localhost."
  for svc in "5432 Postgres" "6379 Redis" "7070 S3"; do
    set -- $svc
    port_open "$1" || fail "$2 is not reachable on localhost:$1" "$(native_install_help)"
  done
else
  command -v docker >/dev/null || fail "Docker is not installed." \
    "Install it (one time):" "$(docker_install_help)" \
    "Then run: pnpm dev:setup" \
    "(Prefer not to use Docker? Run your own Postgres/Redis/S3 and use: MAXCLOUD_NO_DOCKER=1 pnpm dev:setup)"
  if ! info=$(docker info 2>&1); then
    case "$info" in
      *"permission denied"*)
        fail "Docker is installed, but your user can't use it." \
          "sudo usermod -aG docker \$USER" "Then log out and back in (or run: newgrp docker) and retry." ;;
      *)
        fail "Docker is installed, but the Docker service isn't running." \
          "sudo systemctl enable --now docker" "Then retry: pnpm dev:setup" ;;
    esac
  fi
  docker compose version >/dev/null 2>&1 || fail "The 'docker compose' plugin is missing." \
    "$( [ "$DISTRO" = fedora ] && echo 'sudo dnf -y install docker-compose-plugin' || echo 'Install docker-compose-plugin from Docker'"'"'s package repo' )"

  docker compose up -d postgres redis s3 mailpit
  printf 'Waiting for Postgres'
  for _ in $(seq 1 60); do
    docker compose exec -T postgres pg_isready -U maxcloud >/dev/null 2>&1 && break
    printf '.'; sleep 1
  done
  echo
  docker compose exec -T postgres pg_isready -U maxcloud >/dev/null 2>&1 \
    || fail "Postgres didn't become ready." "Check: docker compose logs postgres"
  # The init script only runs on a fresh volume; make sure the test DB exists either way.
  docker compose exec -T postgres psql -U maxcloud -tc "SELECT 1 FROM pg_database WHERE datname='maxcloud_test'" | grep -q 1 \
    || docker compose exec -T postgres createdb -U maxcloud maxcloud_test
  wait_port 6379 Redis 30 || fail "Redis didn't start." "Check: docker compose logs redis"
  wait_port 7070 S3 60 || fail "The S3 server didn't start on :7070." "Check: docker compose logs s3"
  SMTP=smtp://localhost:1025
fi

say "Environment files"
if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env
  sed -i.bak "s#^SMTP_URL=.*#SMTP_URL=${SMTP}#" apps/api/.env && rm -f apps/api/.env.bak
fi
# Fresh random secrets for this machine (dev only).
if grep -q 'dev-only-jwt-secret' apps/api/.env; then
  sed -i.bak "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -hex 32)#; s#^APP_ENCRYPTION_KEY=.*#APP_ENCRYPTION_KEY=$(openssl rand -hex 32)#" apps/api/.env && rm -f apps/api/.env.bak
fi

say "Dependencies"
pnpm install
pnpm --filter @maxcloud/shared build

say "Database migrations + seed (demo data)"
( cd apps/api && npx prisma generate >/dev/null && npx prisma migrate deploy && set -a && . ./.env && set +a && npx tsx prisma/seed.ts )

cat <<'MSG'

Done. Start everything with:   pnpm dev
  Web     http://localhost:3000   (demo@maxcloud.uz / demo-password-2026, admin@maxcloud.uz / admin-password-2026)
  API     http://localhost:4000   (OpenAPI: docs/openapi.json)
  Mail    http://localhost:8025   (Mailpit, when using Docker)
  Shared  http://localhost:3000/s/demo-samarkand-album
Tests: pnpm test (unit + integration)   ·   pnpm e2e (Playwright)
MSG
