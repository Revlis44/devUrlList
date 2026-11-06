#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="${1:-/data/devurllist}"
app_uid="${APP_UID:-${SUDO_UID:-$(id -u)}}"
app_gid="${APP_GID:-${SUDO_GID:-$(id -g)}}"

if [[ $# -gt 1 || "$deploy_dir" == '-h' || "$deploy_dir" == '--help' ]]; then
  printf '%s\n' '사용법: bash scripts/install-docker.sh [/data/devurllist]'
  exit 0
fi

if [[ ! "$app_uid" =~ ^[0-9]+$ || ! "$app_gid" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'APP_UID와 APP_GID는 숫자로 지정해 주세요.' >&2
  exit 1
fi
if [[ "$app_uid" -eq 0 ]]; then app_uid=1000; fi
if [[ "$app_gid" -eq 0 ]]; then app_gid=1000; fi
if [[ $(id -u) -ne 0 && ( "$app_uid" -ne $(id -u) || "$app_gid" -ne $(id -g) ) ]]; then
  printf '%s\n' '다른 사용자 소유로 설치하려면 sudo로 실행해 주세요.' >&2
  exit 1
fi

mkdir -p -- "$deploy_dir"
deploy_dir="$(cd -- "$deploy_dir" && pwd -P)"
if [[ "$deploy_dir" == / || "$deploy_dir" == "$project_dir" ]]; then
  printf '%s\n' '프로젝트 폴더와 다른 전용 설치 경로를 지정해 주세요.' >&2
  exit 1
fi

for directory in app compose sqlite logs backup; do
  if [[ -L "$deploy_dir/$directory" ]]; then
    printf '심볼릭 링크 대신 실제 폴더를 사용해 주세요: %s\n' "$deploy_dir/$directory" >&2
    exit 1
  fi
done
for directory in app compose; do
  if [[ -d "$deploy_dir/$directory" && -n "$(ls -A -- "$deploy_dir/$directory")" ]]; then
    printf '기존 파일을 덮어쓰지 않습니다: %s\n기존 설치는 compose/run.sh로 실행해 주세요.\n' "$deploy_dir/$directory" >&2
    exit 1
  fi
done

umask 022
mkdir -p -- "$deploy_dir"/{app,compose,sqlite,logs,backup}
mkdir -p -- "$deploy_dir/app/docker"
cp -- "$project_dir/package.json" "$project_dir/server.js" "$project_dir/seed.example.json" "$deploy_dir/app/"
cp -R -- "$project_dir/lib" "$project_dir/public" "$deploy_dir/app/"
cp -- "$project_dir/docker/logging.js" "$deploy_dir/app/docker/"
cp -- "$project_dir/docker/compose.yaml" "$project_dir/docker/run.sh" "$deploy_dir/compose/"
sed -e "s/^APP_UID=.*/APP_UID=$app_uid/" -e "s/^APP_GID=.*/APP_GID=$app_gid/" \
  "$project_dir/docker/.env.example" > "$deploy_dir/compose/.env"
chmod 755 "$deploy_dir/compose/run.sh"
chmod 600 "$deploy_dir/compose/.env"
chmod 700 "$deploy_dir/sqlite" "$deploy_dir/logs" "$deploy_dir/backup"
if [[ $(id -u) -eq 0 ]]; then
  chown -R "$app_uid:$app_gid" "$deploy_dir/sqlite" "$deploy_dir/logs" "$deploy_dir/backup"
  chown "$app_uid:$app_gid" "$deploy_dir/compose/.env"
fi

printf '설치 준비 완료: %s\n컨테이너 실행 사용자: %s:%s\n' "$deploy_dir" "$app_uid" "$app_gid"
printf '실행: cd "%s/compose" && ./run.sh up -d --wait\n' "$deploy_dir"
printf '%s\n' '기존 DB는 복사하지 않았습니다. 이전하려면 기존 서버를 종료한 뒤 sqlite/로 옮겨 주세요.'
