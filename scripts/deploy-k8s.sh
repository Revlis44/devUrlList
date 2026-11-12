#!/bin/sh
set -eu
: "${MIGRATION_JOB:?MIGRATION_JOB is required}"
test -s .release/app.yaml
test -s .release/migration-job.yaml
kubectl -n devurllist get statefulset mariadb >/dev/null
kubectl -n devurllist get deployment/devurllist service/devurllist configmap/devurllist-config poddisruptionbudget/devurllist --ignore-not-found -o json > .release/previous.json
node scripts/prepare-rollback.js
kubectl create -f .release/migration-job.yaml
if ! kubectl -n devurllist wait --for=condition=complete --timeout=300s "job/$MIGRATION_JOB"; then
  kubectl -n devurllist logs "job/$MIGRATION_JOB" || true
  echo '스키마 작업 실패: 앱 배포를 진행하지 않습니다.' >&2
  exit 1
fi
kubectl -n devurllist logs "job/$MIGRATION_JOB"
rollback() {
  if [ -s .release/rollback.json ]; then
    echo '이전 앱 설정으로 복귀합니다. DB 스키마는 유지합니다.' >&2
    kubectl apply -f .release/rollback.json &&
      kubectl -n devurllist rollout status deployment/devurllist --timeout=300s ||
      echo '자동 복귀 실패: 운영자 확인이 필요합니다.' >&2
  else
    echo '최초 배포에는 이전 앱이 없습니다. 접속 경로는 변경하지 않았습니다.' >&2
  fi
}
if ! kubectl apply -f .release/app.yaml ||
   ! kubectl -n devurllist rollout status deployment/devurllist --timeout=300s ||
   ! node scripts/smoke.js http://devurllist.devurllist.svc.cluster.local:3000; then
  rollback
  exit 1
fi
if [ "${VERIFY_PUBLIC:-false}" = true ] &&
   ! node scripts/smoke.js https://devurl.intra.sayinfo.co.kr; then
  rollback
  exit 1
fi
echo '앱 순차 배포와 상태 검증 완료'
