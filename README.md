# devUrlList

사내 개발서버의 주소, 접속 계정, IP와 포트를 함께 관리하는 웹페이지입니다. HTML/CSS/JavaScript 화면과 Node.js 서버, SQLite를 사용하며 외부 패키지나 빌드 과정이 필요하지 않습니다.

프로젝트명과 폴더명은 `devUrlList`입니다. 소스 저장소는 [Revlis44/devUrlList](https://github.com/Revlis44/devUrlList)입니다.

## 실행

Node.js **24 이상**을 설치한 뒤 저장소를 내려받아 실행합니다.

```sh
git clone https://github.com/Revlis44/devUrlList.git
cd devUrlList
npm start
```

기본 주소는 `http://127.0.0.1:3000`입니다. 로그인 화면의 **계정 만들기**에서 아이디(공백 없이 1~40자), 이름(2~40자), 직급(직접 입력, 1~40자), 비밀번호(1~128자)를 입력합니다. 로그인은 아이디와 비밀번호를 사용하며, 로그인 후 상단에 이름·아이디·직급을 표시합니다. 아이디는 영문 대소문자를 구분하지 않고 중복을 확인합니다. 비밀번호는 8자 미만도 사용할 수 있으며, 빈 값이나 공백만으로는 설정할 수 없습니다. 기본 관리자나 공용 로그인 계정은 없으며, 가입한 모든 사용자가 동일하게 목록을 추가·수정·삭제할 수 있습니다. 같은 이름은 중복 가입할 수 없습니다.

기존 계정이 없는 설치 환경을 기준으로 하며, 서버를 시작하면 기존 DB의 사용자 테이블에 아이디·직급 항목을 추가합니다. 등록된 서버 목록과 변경 기록은 유지됩니다.

다른 사내 PC에서 접근하도록 실행하려면 다음과 같이 지정합니다.

```sh
HOST=0.0.0.0 PORT=3000 npm start
```

브라우저에서 `http://서버IP:3000`으로 접속합니다. 서버 방화벽에서는 사내망에서만 접근하도록 제한합니다. HTTPS 프록시를 이용할 때는 아래 설정을 함께 사용합니다. `APP_ORIGIN`에는 사용자가 브라우저에 입력하는 최종 주소를 경로·끝 슬래시 없이 지정합니다. 프록시는 이 주소의 루트를 애플리케이션에 연결합니다.

```sh
HOST=127.0.0.1 PORT=3000 \
APP_ORIGIN=https://servers.example.com COOKIE_SECURE=true \
node server.js
```

HTTP로 접속할 때는 `COOKIE_SECURE=true`를 사용하지 않습니다. `.env` 자동 로딩은 없으며 환경변수를 직접 설정하거나 Node의 `--env-file` 옵션을 사용할 수 있습니다. 배포 시 Node 프로세스 하나를 서비스 관리 도구(systemd 등)에 등록하고 자동 재시작을 설정하세요. 한 DB에 여러 프로세스를 동시에 연결하지 않습니다.

## Docker 실행

Linux 서버의 기본 설치 경로를 `/data/devurllist`로 사용합니다. 설치 스크립트에 다른 경로를 전달해도 됩니다. Docker Engine과 Docker Compose v2 이상이 필요하며, 서버에 Node.js를 별도로 설치할 필요는 없습니다. 의존 패키지가 없어 `node:24-bookworm-slim` 공식 이미지에서 소스를 직접 실행합니다.

```text
/data/devurllist/
├── compose/
│   ├── compose.yaml
│   ├── .env                 접속 포트, 실행 사용자, HTTPS 설정
│   └── run.sh               Docker Compose 실행 도우미
├── app/                     실행할 소스 (컨테이너에서 읽기 전용)
│   ├── server.js
│   ├── package.json
│   ├── seed.example.json
│   ├── lib/
│   ├── public/
│   └── docker/logging.js
├── sqlite/                  sites.sqlite 및 WAL/SHM 파일
├── logs/                    app-YYYY-MM-DD.log (한국 날짜)
└── backup/                  변경 전 SQLite 백업
```

프로젝트 소스를 받은 폴더에서 최초 설치를 준비합니다. 스크립트는 실행에 필요한 소스만 복사하며 실제 사내 데이터, `.git`, 테스트 파일, 기존 백업은 복사하지 않습니다. 컨테이너도 자동으로 시작하지 않습니다.

```sh
sudo bash scripts/install-docker.sh /data/devurllist
cd /data/devurllist/compose
./run.sh config --quiet
./run.sh up -d --wait
./run.sh ps
```

기본 접속 주소는 `http://서버IP:8188`입니다. 컨테이너 내부의 3000 포트를 서버의 8188 포트로 연결합니다. Docker 실행 권한이 없는 계정에서는 `sudo ./run.sh ...` 형태로 실행합니다. 스크립트는 `docker compose`를 우선 사용하고, 플러그인이 없으면 `docker-compose` 명령을 사용합니다. 최초 실행 시 공식 이미지를 내려받으므로 이미지 저장소에 접근할 수 있어야 합니다.

`compose/.env`에서 필요한 값만 수정한 뒤 `./run.sh up -d --wait`로 다시 적용합니다.

기존 설치에서 포트를 바꾸려면 `/data/devurllist/compose/.env`의 `APP_PORT=3000`을 `APP_PORT=8188`로 수정하고, 해당 폴더에서 `docker compose up -d --force-recreate`를 실행합니다. 기존 `.env` 값이 Compose 파일의 기본값보다 우선하므로 실제 설치된 `.env`도 변경해야 합니다.

| 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `APP_PORT` | `8188` | 서버에서 공개할 HTTP 포트 |
| `BIND_IP` | `0.0.0.0` | 접속을 받을 서버 IP. 같은 서버의 HTTPS 프록시만 사용하면 `127.0.0.1`로 변경 |
| `APP_UID`, `APP_GID` | 설치 실행 사용자 기준 | SQLite·로그·백업 파일의 소유자와 컨테이너 실행 사용자 |
| `APP_ORIGIN` | 빈 값 | HTTPS 프록시를 사용할 때 브라우저의 최종 주소. 예: `https://servers.example.com` |
| `COOKIE_SECURE` | `false` | HTTPS 프록시를 사용할 때 `true`로 변경 |

`sudo`로 설치하면 원래 사용자의 UID/GID를 사용합니다. root 계정에서 직접 설치하면 1000:1000으로 지정합니다. 다른 소유자가 필요하면 설치할 때 `sudo APP_UID=1000 APP_GID=1000 bash scripts/install-docker.sh /data/devurllist`처럼 지정합니다. 설치 후 UID/GID를 바꾸면 `sqlite`, `logs`, `backup`의 소유자도 함께 변경해야 합니다. 파일은 컨테이너를 내려도 호스트에 그대로 보관됩니다. 사내 공유용이므로 서버 방화벽은 사내망 접근만 허용하세요.

운영 명령은 다음과 같습니다.

```sh
cd /data/devurllist/compose
./run.sh logs -f --tail 100    # 실행·오류 로그 확인
./run.sh restart              # 애플리케이션 재시작
./run.sh down                 # 컨테이너 종료, 데이터 폴더는 유지
./run.sh up -d --wait         # 다시 실행
```

`logs/`에는 표준 출력·오류가 한국 시간과 함께 날짜별로 쌓입니다. Docker 로그에서도 같은 내용을 확인할 수 있으며 Docker 로그는 10MB 파일 3개로 순환합니다. 호스트의 날짜별 로그와 DB 백업은 자동 삭제하지 않으므로 보관 기간과 디스크 용량은 운영 환경에 맞게 관리합니다. 컨테이너는 비관리자 권한으로 실행하며 서버 재시작 시 다시 올라옵니다. 상태 확인 실패는 `unhealthy`로 표시되고, 프로세스가 종료되면 재시작됩니다.

### 기존 SQLite 데이터 이전

실제 사내 데이터 9개를 유지하려면 **첫 컨테이너 실행 전에** 다음 순서로 옮깁니다.

1. 기존 Node.js 서버를 정상 종료합니다. 실행 중인 DB 파일만 따로 복사하지 않습니다.
2. 원본 프로젝트의 `data/` 내용 전체를 설치 폴더의 `sqlite/`로 복사합니다. 기존 `backups/`가 있으면 설치 폴더의 `backup/`으로 복사합니다. 대상에 기존 DB가 있으면 먼저 별도 보관합니다.
3. 복사한 파일과 폴더의 소유자를 `compose/.env`의 `APP_UID:APP_GID`로 맞춥니다. 예: `sudo chown -R 1000:1000 /data/devurllist/sqlite /data/devurllist/backup`.
4. `compose/run.sh up -d --wait`로 실행합니다.

데이터를 옮기지 않으면 공개용 가상 예시 2개로 새 DB를 생성합니다. 최초 설치 스크립트는 기존 `app` 또는 `compose`에 파일이 있으면 중단하여 운영 소스와 설정을 덮어쓰지 않습니다. 소스를 갱신할 때는 컨테이너를 내리고 `app/`의 실행 파일만 새 버전으로 교체한 뒤 다시 실행합니다. `sqlite/`, `logs/`, `backup/`, `compose/.env`는 유지합니다.

Docker 구성은 [Compose 서비스 명세](https://docs.docker.com/reference/compose-file/services/)와 [Node.js 공식 이미지](https://github.com/nodejs/docker-node)를 기준으로 작성했습니다.

## 기능

- 컬럼: 순서, 시스템명, URL, 공통계정, IP, 서비스포트, SSH포트, 서버계정, 외부접근가능여부, 비고, 관리·기록.
- 순서 오름차순 정렬. 같은 순서는 등록 순서로 정렬합니다. 순서는 편집 창에서 변경할 수 있습니다.
- 시스템명·URL·IP·비고 검색과 외부접근 여부 필터. 계정 내용은 검색 대상에서 제외합니다.
- 등록 사용자는 모두 추가·수정·삭제 가능. 삭제 확인 후 실제 데이터는 보존하는 논리 삭제를 사용합니다.
- 삭제된 목록은 기본 접힘 상태이며 `+ / −`로 펼치거나 접습니다. 회색 표에서도 기록보기를 사용할 수 있습니다.
- 기록보기 팝업에서 작업자, 한국 시간, 항목별 변경 전·후 값을 확인합니다. 초기 등록, 추가, 수정, 삭제를 모두 기록합니다.
- 공통계정·서버계정은 표와 이력에서 기본 가림 처리하며 보기 버튼으로 확인합니다.
- 다른 사용자가 먼저 저장한 경우 이전 화면의 수정·삭제는 거절합니다. 입력 내용을 보관하고 창을 닫은 다음 목록을 새로고침해 다시 수정하세요.
- 목록은 처음 열 때, 본인의 변경 후, 새로고침 버튼 클릭 시 갱신합니다.
- 로그인은 12시간 유지됩니다. 비밀번호는 무작위 salt와 scrypt로 해시 저장하고 세션 토큰은 해시만 DB에 저장합니다. HttpOnly / SameSite 쿠키, 출처 검증, 인증 시도 제한을 적용합니다.
- 프록시 환경에서는 인증 시도 제한이 프록시 IP 기준으로 적용됩니다(15분 동안 가입·로그인 30회). 소규모 사내 서비스 기준입니다.

## 초기 데이터

새 DB를 만들 때만 `data/initial-sites.json`을 읽고, 없으면 `seed.example.json`을 사용합니다. 이미 데이터가 있으면 재시작해도 초기 데이터를 중복 삽입하지 않습니다.

공개 저장소의 `seed.example.json`에는 가상 주소를 사용하는 예시 시스템 2개만 포함합니다. 실제 사내 시스템 정보는 로컬 `data/initial-sites.json` 또는 생성된 SQLite DB에서 관리하며 저장소에 올리지 않습니다. 기존 로컬 DB의 실제 시스템 9개는 프로젝트명과 폴더명을 변경해도 그대로 유지됩니다.

실제 주소·IP·계정·비밀번호는 공개 예시에서 제외합니다. 서버 이전 시 데이터를 유지하려면 앱을 정상 종료한 뒤 `data/` 폴더를 같이 옮깁니다. `.gitignore`는 데이터·백업·화면 캡처를 소스관리에서 제외합니다. 소스만 새로 내려받으면 실제 사내 데이터 대신 가상 예시가 표시됩니다.

## 백업과 복구

- DB: `data/sites.sqlite`, 실행 중 WAL 관련 파일이 함께 생성될 수 있습니다.
- 백업: `backups/<UTC시각>_<작업종류>_<고유값>.sqlite`.
- 가입 및 목록 추가·수정·삭제 **직전**에 SQLite 백업 API로 전체 DB의 일관된 스냅샷을 생성합니다. 변경 없는 저장, 로그인·로그아웃, 초기 데이터 삽입에는 백업을 만들지 않습니다.
- 백업 파일 생성 후에만 변경과 이력을 한 트랜잭션으로 저장합니다. 백업 실패 시 변경하지 않으며 사용자에게 오류를 표시합니다. 저장 중 실패하면 변경과 이력이 함께 롤백됩니다.
- 백업에는 사용자 정보, 공유 계정, 이전 이력도 포함됩니다. 폴더는 0700, DB·백업 파일은 0600 권한으로 생성합니다. 백업 폴더를 웹서버의 공개 경로로 연결하지 마세요.
- `DATA_DIR`, `BACKUP_DIR` 환경변수로 경로를 바꿀 수 있습니다. 백업은 자동 삭제하지 않으므로 보관 용량을 관리하세요. 서버 디스크 장애에도 대비하려면 백업 폴더를 별도 저장소에도 보관합니다.
- 로그인 비밀번호와 달리 **목록에 적은 공유 계정 비밀번호는 조회가 가능해야 하므로 DB와 백업에 평문으로 저장**됩니다. 파일 접근 권한을 운영 담당자로 제한하세요.

복구는 전체 DB 기준이며 운영 서버를 종료한 상태에서 진행합니다.

1. 서버를 정상 종료합니다.
2. 현재 `data/` 폴더를 별도 경로로 보관합니다. 기존 WAL/SHM 파일이 복구 DB와 섞이지 않도록 기존 폴더를 그대로 이동하는 방식을 사용합니다.
3. 빈 데이터 폴더에 원하는 백업 파일을 `sites.sqlite` 이름으로 복사하고 접근 권한을 설정합니다.
4. 아래 명령으로 이전 세션을 지운 뒤 서버를 시작하고 로그인합니다. 백업 시점 이후 데이터는 포함되지 않습니다.

```sh
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('data/sites.sqlite'); db.exec('DELETE FROM sessions'); db.close();"
```

## 검증

```sh
npm test
```

별도 임시 DB로 로그인·가입, 두 사용자 변경 이력, 동시 수정 충돌, 변경 전 백업의 무결성과 실제 내용, 백업 실패 시 저장 중단, 삭제 보관, 요청 검증, 트랜잭션 롤백, 재시작 후 데이터 유지를 확인합니다. 운영 데이터는 테스트에 사용하지 않습니다. Docker 관련 검증은 설치 디렉터리와 파일 권한, 실제 데이터의 복사 제외, 날짜별 로그, 배치된 소스의 재시작 후 데이터 유지도 확인합니다. Docker Engine을 사용하는 실제 컨테이너 검증과는 구분됩니다.

## 파일

```text
server.js           HTTP 서버, 인증, 세션, API
lib/store.js        SQLite 저장, 변경 이력, 백업, 입력 검증
public/index.html   로그인·목록·편집·이력 화면
public/styles.css   반응형 스타일
public/app.js       검색, 인증, 목록 관리, 팝업 동작
public/favicon.png 파비콘 및 로그인 화면 마크
seed.example.json  비밀번호 없는 초기 목록 예시
test/app.test.js    기능·저장·인증 통합 검증
docker/compose.yaml Docker 컨테이너와 디렉터리 연결
docker/.env.example Docker 환경설정 예시
docker/run.sh       설치 폴더에서 Compose 명령 실행
docker/logging.js   표준 출력과 날짜별 파일 로그 동시 기록
scripts/install-docker.sh 설치 디렉터리 및 실행 소스 준비
test/docker.test.js 설치·로그·배치 경로 통합 검증
```

CSS·JavaScript URL에는 `?ver=yyyyMMdd` 캐시 버전을 적용합니다. 같은 날짜에 다시 변경하면 `_N`을 붙입니다. 화면 작업 전후 캡처는 프로젝트의 `frontDiff/`에 보관합니다.

SQLite 백업 구현은 [Node.js 24 SQLite 문서](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)를 참고했습니다.
