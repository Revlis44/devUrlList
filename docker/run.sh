#!/usr/bin/env bash
set -euo pipefail

compose_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$compose_dir/.env" ]]; then
  printf '%s\n' '먼저 scripts/install-docker.sh로 설치 폴더를 준비해 주세요.' >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  printf '%s\n' '사용법: ./run.sh up -d --wait | down | restart | logs -f --tail 100 | ps | config'
  exit 0
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_command=(docker compose)
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  compose_command=(docker-compose)
else
  printf '%s\n' 'Docker Compose v2 이상을 설치해 주세요.' >&2
  exit 1
fi

cd -- "$compose_dir"
exec "${compose_command[@]}" --env-file "$compose_dir/.env" -f "$compose_dir/compose.yaml" "$@"
