# devUrlList

사내 개발서버의 주소, 접속 계정, IP와 포트를 함께 관리하는 웹페이지입니다. HTML/CSS/JavaScript 화면과 Node.js 서버를 사용합니다. 기본 SQLite 실행에는 외부 패키지가 필요하지 않으며, Rancher용 MariaDB 실행은 `npm ci`로 고정된 드라이버를 설치합니다.

프로젝트명과 폴더명은 `devUrlList`입니다. 소스 저장소는 [Revlis44/devUrlList](https://github.com/Revlis44/devUrlList)입니다.

최종 HTTPS 접속 주소는 `https://devurl.intra.sayinfo.co.kr`입니다. Harbor 프로젝트와 Kubernetes 네임스페이스 이름은 `devurllist`이며, 접속 도메인의 `devurl`과 구분합니다.

## 실행

Node.js **24 이상**을 설치한 뒤 저장소를 내려받아 실행합니다.

```sh
git clone https://github.com/Revlis44/devUrlList.git
cd devUrlList
npm start
```

기본 주소는 `http://127.0.0.1:3000`입니다. 로그인 화면의 **계정 만들기**에서 아이디(공백 없이 1~40자), 이름(2~40자), 직급(직접 입력, 1~40자), 비밀번호(1~128자)를 입력합니다. 로그인은 아이디와 비밀번호를 사용하며, 로그인 후 상단에 이름·아이디·직급을 표시합니다. 아이디는 영문 대소문자를 구분하지 않고 중복을 확인합니다. 비밀번호는 8자 미만도 사용할 수 있으며, 빈 값이나 공백만으로는 설정할 수 없습니다. 기본 관리자나 공용 로그인 계정은 없으며, 가입한 모든 사용자가 동일하게 목록을 추가·수정·삭제할 수 있습니다. 같은 이름은 중복 가입할 수 없습니다.

SQLite 실행은 서버 시작 시 기존 DB의 사용자 테이블에 아이디·직급 항목을 추가하며 등록된 서버 목록과 변경 기록을 유지합니다. MariaDB 실행은 별도의 스키마 작업과 데이터 이전을 먼저 완료해야 하며, 예시 데이터를 자동 생성하지 않습니다.

다른 사내 PC에서 접근하도록 실행하려면 다음과 같이 지정합니다.

```sh
HOST=0.0.0.0 PORT=3000 npm start
```

브라우저에서 `http://서버IP:3000`으로 접속합니다. 서버 방화벽에서는 사내망에서만 접근하도록 제한합니다. HTTPS 프록시를 이용할 때는 아래 설정을 함께 사용합니다. `APP_ORIGIN`에는 사용자가 브라우저에 입력하는 최종 주소를 경로·끝 슬래시 없이 지정합니다. 프록시는 이 주소의 루트를 애플리케이션에 연결합니다.

```sh
HOST=127.0.0.1 PORT=3000 \
APP_ORIGIN=https://devurl.intra.sayinfo.co.kr COOKIE_SECURE=true \
node server.js
```

HTTP로 접속할 때는 `COOKIE_SECURE=true`를 사용하지 않습니다. `.env` 자동 로딩은 없으며 환경변수를 직접 설정하거나 Node의 `--env-file` 옵션을 사용할 수 있습니다. SQLite 배포는 Node 프로세스 하나만 연결합니다. MariaDB 배포는 아래 Rancher 구성처럼 여러 앱이 같은 DB를 사용합니다.

## Docker 실행

기존 SQLite Docker 실행 방식입니다. Linux 서버의 기본 설치 경로는 `/data/devurllist`이며 설치 스크립트에 다른 경로를 전달할 수 있습니다. Docker Engine과 Docker Compose v2 이상이 필요합니다. SQLite 경로는 의존 패키지 없이 `node:24-bookworm-slim` 공식 이미지에서 실행합니다. MariaDB용 이미지는 루트의 `Dockerfile`로 빌드합니다.

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
| `APP_ORIGIN` | 빈 값 | 빈 값이면 현재 요청 주소를 사용합니다. 최종 HTTPS 접속 주소는 `https://devurl.intra.sayinfo.co.kr`로 지정합니다. |
| `COOKIE_SECURE` | `false` | HTTPS 프록시를 사용할 때 `true`로 변경 |

HTTPS 주소에서 로그인할 때 **“요청 출처를 확인할 수 없습니다”**가 표시되면 `/data/devurllist/compose/.env`에 아래 두 값을 설정합니다. `APP_ORIGIN`은 실제 브라우저 주소와 프로토콜·도메인·포트가 일치해야 하며, 경로와 끝 슬래시는 제외합니다.

```dotenv
APP_ORIGIN=https://devurl.intra.sayinfo.co.kr
COOKIE_SECURE=true
```

설정 후 `/data/devurllist/compose`에서 `docker compose up -d --force-recreate --wait app`을 실행합니다. `restart`만 하면 변경한 환경변수가 적용되지 않습니다. 이후 지정한 HTTPS 주소로 접속하며, HTTP 주소나 다른 도메인의 로그인·저장 요청은 차단됩니다.

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

- 화면은 **좌측 그룹·시스템 트리 → 가운데 시스템 목록 → 우측 선택한 시스템 상세**의 탐색기 구조입니다. 그룹을 선택하면 하위 그룹을 포함한 소속 시스템을, 트리의 시스템을 선택하면 해당 시스템 한 개를 가운데에 표시합니다. 가운데 목록에서 선택한 시스템의 접속 정보·하위 정보·수정·삭제·변경 기록은 우측에서 확인합니다.
- 상단의 **등록 시스템 / 외부접근 가능 / 삭제된 시스템** 현황은 전체 데이터 기준으로 표시합니다. 검색·필터·그룹 선택으로 현황 수치가 바뀌지 않습니다. 기존 파란색 계열과 라이트·다크 모드, 파비콘 로고를 유지합니다.
- 가운데 시스템에는 `01, 02, 03…` 연속 번호를 표시합니다. 그룹과 그룹 안의 시스템은 지정한 순서로 정렬합니다. 좌측 트리에서 시스템을 다른 시스템의 위·아래로 끌어 순서를 바꾸거나, 그룹명에 놓아 해당 그룹의 맨 뒤로 이동합니다. 빈 그룹·하위 그룹·미분류로도 이동할 수 있습니다. 시스템에 초점을 두고 `Alt+↑/↓`로 순서를 바꿀 수 있으며, 터치 화면에서는 시스템 수정 창에서 그룹을 변경합니다. 이동은 서버에 저장하여 새로고침 후에도 유지하고, 변경 전 백업·변경 기록·동시 수정 검증을 적용합니다. 기존 시스템은 첫 이동 전까지 등록 순서를 유지합니다.
- 그룹 이름을 다른 그룹의 **위·아래**에 놓으면 해당 그룹과 같은 단계에서 순서를 변경하고, **가운데**에 놓으면 해당 그룹의 마지막 하위 그룹으로 이동합니다. 그룹을 끌 때 나타나는 **최상위 그룹으로 이동** 영역에 놓으면 최상위 마지막으로 이동합니다. 하위 그룹과 소속 시스템은 그대로 따라가며, 미분류는 그룹 이동 대상이 아닙니다. 그룹에도 `Alt+↑/↓` 순서 변경을 지원합니다. 자기 자신·자신의 하위 그룹으로의 이동, 같은 단계의 이름 중복, 오래된 버전의 이동 요청은 거절합니다. 그룹 순서는 DB의 기존 메타데이터에 저장하고 트리·목록·그룹 선택창에 함께 적용합니다. 첫 순서 변경 전에는 기존 이름순을 유지하며, 지정 순서가 있으면 새 그룹은 같은 단계의 마지막에 추가됩니다. 그룹 이동은 변경 전 백업을 생성하며 별도의 그룹 이력 화면은 추가하지 않습니다.
- 좌측 그룹은 접고 펼칠 수 있으며, 그룹과 시스템을 소속 깊이에 맞춰 들여씁니다. 기존 서버는 데이터 변경 없이 **미분류**로 표시합니다. 작은 화면에서는 트리·목록·상세를 세로로 배치합니다.
- 우측 **하위 정보**에서 WAS·WEB·DB·Reverse Proxy·기타 항목을 개별 또는 모두 접고 펼칠 수 있습니다. **추가·수정** 또는 시스템 수정 창에서 여러 항목을 등록하며 WEB 없이 Traefik 같은 Reverse Proxy만 등록하는 구성도 지원합니다. 하위 정보는 처음에 접혀 있고 목록 새로고침과 시스템 이동 중 펼침 상태를 유지합니다. 검색·필터 적용 중에는 선택한 시스템의 하위 정보가 자동으로 펼쳐지며, 해제하면 이전 상태로 돌아갑니다. 하위 항목은 시스템 수와 순서 번호에 포함하지 않습니다.
- URL은 **기타** 유형에서만 직접 입력합니다. WAS·DB에는 URL 입력란과 링크를 표시하지 않고, WEB·Reverse Proxy는 시스템 URL을 참조해 표시합니다. 시스템 URL 변경도 즉시 반영되며 별도 WEB 항목을 요구하지 않습니다. DB의 공통계정은 입력창·목록·변경 기록에서 **DB계정**, 입력창의 서비스포트는 **DB포트**로 표시합니다. 기존에 저장된 URL과 계정은 삭제하거나 일괄 변경하지 않으며, 과거 기록에도 남습니다.
- 하위 항목의 IP와 SSH포트는 각각 **시스템과 동일**을 선택하거나 직접 입력합니다. 신규 하위 항목은 두 값 모두 시스템과 동일로 시작하며, 선택한 항목은 시스템 값 변경 시 함께 반영됩니다. 시스템 값이 비어 있으면 미등록으로 표시합니다. 하위 항목 추가·수정·제거는 **저장하기**를 눌러야 반영되며, 시스템과 함께 자동 백업·변경 기록·동시 수정 검증을 적용합니다. 시스템을 삭제해도 하위 정보는 삭제된 목록과 기록에 보관됩니다.
- 상단의 해·달 아이콘으로 라이트·다크 모드를 선택합니다. 선택한 모드는 이 브라우저에 저장하며 목록·입력창·변경 기록·로그인 화면에 함께 적용합니다. 저장된 선택이 없으면 라이트 모드로 시작합니다.
- 상단 이름 옆의 연필 아이콘을 누르면 **내 계정 정보**에서 본인의 이름·직급을 수정할 수 있습니다. 아이디·비밀번호는 그대로 유지합니다. 이름 중복을 검사하고 변경 전 백업을 생성합니다. 과거 기록의 이름은 당시 이름을 보존하며, 직급은 기존 방식대로 현재 계정 정보로 표시합니다.
- 좌측에서 그룹을 선택하면 가운데 목록 상단에 **시스템 추가**가 표시됩니다. 추가 폼에는 선택한 그룹이 미리 지정되며 미분류·하위 그룹에도 적용합니다.
- 상단 **그룹 관리**에서 그룹 추가, 이름 변경, 상위 그룹 변경, 빈 그룹 삭제를 할 수 있습니다. 동일 위치의 중복 이름, 자기 자신이나 하위 그룹으로의 이동은 차단합니다. 해당 그룹이나 하위 그룹에 활성 서버가 있으면 삭제할 수 없습니다. 활성 서버가 없으면 빈 하위 그룹도 함께 삭제하며, 삭제된 서버와 변경 기록은 보관합니다.
- 시스템 추가·수정 창에서 그룹을 지정하거나 미분류로 이동합니다. 서버의 그룹 변경은 당시 그룹 경로와 함께 기존 변경 기록에 저장합니다. 그룹 자체의 이름·상위 그룹 변경에는 별도 이력 화면을 제공하지 않으며 변경 전 DB 백업으로 보관합니다.
- 선택한 그룹·시스템·삭제된 목록 안에서 그룹명·시스템명·하위 항목명·구분·URL·IP·비고 검색과 시스템 외부접근 여부 필터를 사용합니다. 하위 항목이 검색되면 소속 시스템과 하위 정보를 함께 표시합니다. 검색·필터 적용 중에는 일치하는 서버의 상위 그룹을 자동으로 펼칩니다. 계정 내용은 검색 대상에서 제외합니다.
- 등록 사용자는 모두 추가·수정·삭제 가능. 삭제 확인 후 실제 데이터는 보존하는 논리 삭제를 사용합니다.
- 좌측 **삭제된 시스템**을 선택하면 보관된 시스템 목록을 표시합니다. 우측에서 하위 정보와 변경 기록을 확인하거나 복구·완전 삭제할 수 있습니다. **복구**를 누르면 기존 그룹으로 복구하고 그룹 경로를 안내합니다. 그룹이 삭제됐다면 필요한 상위 그룹까지 함께 복구하고 그룹도 복구했음을 안내합니다. 같은 위치에 같은 이름의 그룹이 다시 생성돼 있으면 해당 그룹을 사용하며, 미분류 서버는 미분류로 복구합니다. 복구한 서버는 그룹의 마지막 순서에 배치하고 접속 정보·하위 정보·기존 변경 기록을 유지합니다. `POST /api/sites/:id/restore`에 현재 `version`을 전달하며, 변경 전 백업·복구 이력·동시 변경 검증을 적용합니다. 그룹 복구와 서버 복구 중 오류가 발생하면 함께 취소합니다.
- 삭제된 목록의 **완전 삭제**를 누르면 서버명과 복구 불가 안내를 확인한 뒤 다시 승인해야 합니다. `DELETE /api/sites/:id/permanent` 요청으로 서버 정보와 해당 변경 기록을 DB에서 함께 삭제합니다. 사용 중인 항목이나 버전이 맞지 않는 요청은 거절합니다. 삭제 직전 자동 백업과 기존 백업 파일은 유지됩니다.
- 상세 화면과 기록보기의 작성자·수정자·삭제자 이름 옆에 현재 계정의 직급을 함께 표시합니다. 기존 기록도 사용자 ID로 직급을 조회하며, 초기 등록 등 계정이 연결되지 않았거나 직급이 없는 경우에는 이름만 표시합니다.
- 기록보기 팝업에서 작업자, 한국 시간, 항목별 변경 전·후 값을 확인합니다. 초기 등록, 추가, 수정, 삭제, 이동, 복구를 모두 기록합니다.
- 공통계정·서버계정은 상세 화면과 이력에서 기본 가림 처리하며 보기 버튼으로 확인합니다.
- 다른 사용자가 먼저 저장한 경우 이전 화면의 수정·삭제는 거절합니다. 입력 내용을 보관하고 창을 닫은 다음 목록을 새로고침해 다시 수정하세요.
- 목록은 처음 열 때, 본인의 변경 후, 새로고침 버튼 클릭 시 갱신합니다.
- 로그인은 12시간 유지됩니다. 비밀번호는 무작위 salt와 scrypt로 해시 저장하고 세션 토큰은 해시만 DB에 저장합니다. HttpOnly / SameSite 쿠키, 출처 검증, 인증 시도 제한을 적용합니다.
- 프록시 환경에서는 인증 시도 제한이 프록시 IP 기준으로 적용됩니다(15분 동안 가입·로그인 30회). 소규모 사내 서비스 기준입니다.

### 그룹 적용 및 API

서버를 재시작하면 기존 DB에 그룹 테이블이 자동으로 추가됩니다. 기존 서버와 변경 이력은 유지됩니다. 그룹 저장도 로그인·요청 출처·버전 검증과 변경 전 백업을 적용합니다.

- `PUT /api/me`: 로그인한 본인의 `name`, `jobTitle`을 수정합니다.
- `PUT /api/sites/:id/move`: `version`, `groupId`와 선택적인 `targetId`, `targetVersion`, `placement` (`before`/`after`)로 순서·그룹을 변경합니다. 대상 시스템이 없으면 그룹 마지막으로 이동합니다.
- `GET /api/sites`: 서버 목록과 그룹 목록을 함께 조회합니다. `treeOrder`는 그룹 안의 정렬에 사용하며 일반 추가·수정 요청에서 직접 지정하지 않습니다.
- `GET /api/groups`, `POST /api/groups`: 그룹 조회·추가 (`name`, `parentId`; 최상위는 `null`).
- `PUT /api/groups/:id`, `DELETE /api/groups/:id`: 그룹 수정·삭제. 현재 `version`을 함께 전달합니다.
- `PUT /api/groups/:id/move`: `version`, `parentId`와 상위 그룹이 있을 때 `parentVersion`을 전달합니다. 같은 단계의 특정 그룹 앞·뒤로 이동하려면 `targetId`, `targetVersion`, `placement` (`before`/`after`)를 함께 전달합니다. 대상이 없으면 마지막에 추가하며 `parentId: null`은 최상위입니다. 응답의 `treeOrder`는 그룹의 정렬에 사용합니다.
- 서버 추가·수정의 `groupId`로 소속 그룹을 지정합니다. `null`은 미분류이며, 수정 요청에서 생략하면 기존 소속을 유지합니다.
- 서버 추가·수정의 `components` 배열로 하위 정보를 함께 저장합니다. 각 항목은 `type` (`WAS`, `WEB`, `DB`, `PROXY`, `OTHER`), `name`과 접속 정보 필드를 사용하며, `useSystemIp`·`useSystemSshPort`가 `true`이면 해당 시스템 값을 사용합니다. 공유하는 값은 하위 항목에 복사하지 않으며, 조회 시 시스템의 `ip`·`sshPort`를 참조합니다. 수정 요청에서 배열을 생략하면 기존 하위 정보를 유지하고, `[]`를 보내면 모두 제거합니다. 기존 DB와 과거 기록은 일괄 수정하지 않습니다.

## 초기 데이터

새 DB를 만들 때만 `data/initial-sites.json`을 읽고, 없으면 `seed.example.json`을 사용합니다. 이미 데이터가 있으면 재시작해도 초기 데이터를 중복 삽입하지 않습니다.

공개 저장소의 `seed.example.json`에는 가상 주소를 사용하는 예시 시스템 2개만 포함합니다. 실제 사내 시스템 정보는 로컬 `data/initial-sites.json` 또는 생성된 SQLite DB에서 관리하며 저장소에 올리지 않습니다. 기존 로컬 DB의 실제 시스템 9개는 프로젝트명과 폴더명을 변경해도 그대로 유지됩니다.

실제 주소·IP·계정·비밀번호는 공개 예시에서 제외합니다. 서버 이전 시 데이터를 유지하려면 앱을 정상 종료한 뒤 `data/` 폴더를 같이 옮깁니다. `.gitignore`는 데이터·백업·화면 캡처를 소스관리에서 제외합니다. 소스만 새로 내려받으면 실제 사내 데이터 대신 가상 예시가 표시됩니다.

## 백업과 복구

- DB: `data/sites.sqlite`, 실행 중 WAL 관련 파일이 함께 생성될 수 있습니다.
- 백업: `backups/<UTC시각>_<작업종류>_<고유값>.sqlite`.
- 가입·계정 정보 수정 및 목록 추가·수정·삭제·완전 삭제·순서/그룹 이동, 그룹 추가·수정·삭제 **직전**에 SQLite 백업 API로 전체 DB의 일관된 스냅샷을 생성합니다. 변경 없는 저장, 로그인·로그아웃, 초기 데이터 삽입에는 백업을 만들지 않습니다.
- 백업 파일 생성 후에만 변경과 이력을 한 트랜잭션으로 저장합니다. 백업 실패 시 변경하지 않으며 사용자에게 오류를 표시합니다. 저장 중 실패하면 변경과 이력이 함께 롤백됩니다.
- 백업에는 사용자 정보, 공유 계정, 이전 이력도 포함됩니다. 폴더는 0700, DB·백업 파일은 0600 권한으로 생성합니다. 백업 폴더를 웹서버의 공개 경로로 연결하지 마세요.
- `DATA_DIR`, `BACKUP_DIR` 환경변수로 경로를 바꿀 수 있습니다. 백업은 자동 삭제하지 않으므로 보관 용량을 관리하세요. 서버 디스크 장애에도 대비하려면 백업 폴더를 별도 저장소에도 보관합니다.
- 로그인 비밀번호와 달리 **목록에 적은 공유 계정 비밀번호는 조회가 가능해야 하므로 DB와 백업에 평문으로 저장**됩니다. 파일 접근 권한을 운영 담당자로 제한하세요.

삭제된 시스템 하나의 복구는 화면의 **삭제된 시스템 → 복구**에서 진행합니다. 백업 파일을 이용한 전체 DB 복구는 운영 서버를 종료한 상태에서 진행합니다.

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

별도 임시 DB로 로그인·가입, 두 사용자 변경 이력, 동시 수정 충돌, 변경 전 백업의 무결성과 실제 내용, 백업 실패 시 저장 중단, 삭제 보관, 요청 검증, 트랜잭션 롤백, 재시작 후 데이터 유지를 확인합니다. 그룹 CRUD, 계층 이동·중복·순환 검증, 서버 소속 변경과 과거 그룹명 기록, 기존 DB 호환성, 그룹 백업 실패·롤백·재시작도 검증합니다. 운영 데이터는 테스트에 사용하지 않습니다. Docker 관련 검증은 설치 디렉터리와 파일 권한, 실제 데이터의 복사 제외, 날짜별 로그, 배치된 소스의 재시작 후 데이터 유지도 확인합니다. Docker Engine을 사용하는 실제 컨테이너 검증과는 구분됩니다.

하위 정보는 WAS·WEB·DB·Reverse Proxy·기타 등록, IP·SSH포트의 개별 공유와 직접 입력, 입력값 검증, 무변경 저장, 기존 요청의 하위 정보 보존, 추가·수정·제거·시스템 삭제 기록과 백업, 동시 수정 차단, 기존 DB 호환성과 재시작 유지, 백업 실패 시 원본 보존을 검증합니다.

## 파일

```text
server.js           HTTP 서버, 인증, 세션, API
lib/store.js        SQLite 저장, 변경 이력, 백업, 입력 검증
public/index.html   로그인·목록·편집·이력 화면
public/styles.css   반응형 스타일
public/app.js       검색, 인증, 목록 관리, 팝업 동작
public/favicon.png 파비콘 및 로그인·목록 상단 로고
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

## Rancher MariaDB 배포 준비

2026-11-13 기준 소스와 설정 파일입니다. 아래 명령은 운영자가 환경과 이전 결과를 확인한 뒤 실행하는 절차이며, 파일 작성·커밋·푸시만으로 운영 환경에 적용되었음을 의미하지 않습니다.

접속 주소와 배포 후 검증 대상은 모두 `https://devurl.intra.sayinfo.co.kr`로 통일합니다.

| 항목 | 설정 파일 | 확정 값 |
|---|---|---|
| 로그인·변경 요청의 허용 주소 | `k8s/app.yaml`의 `APP_ORIGIN` | `https://devurl.intra.sayinfo.co.kr` |
| HTTPS 전용 세션 쿠키 | `k8s/app.yaml`의 `COOKIE_SECURE` | `"true"` |
| 배포 후 외부 검증 주소 | `scripts/deploy-k8s.sh`의 HTTPS 검증 | `https://devurl.intra.sayinfo.co.kr` |

기존 Traefik의 도메인·TLS 설정을 사용하며, `k8s/cutover/`는 데이터 이전과 앱 검증 후 기존 라우팅의 연결 대상을 새 서비스로 전환할 때만 적용합니다. `k8s/bootstrap/network-policy.yaml`의 `Ingress`는 앱·DB로 들어오는 통신 허용 규칙으로, 도메인 라우팅을 생성하거나 변경하지 않습니다.

앱은 `devurllist` 네임스페이스에서 2개로 실행하고, MariaDB 11.4.8 StatefulSet 1개와 Ceph RBD 10Gi를 공유합니다. 앱 변경 전 백업은 별도 CephFS RWX 10Gi에 보관합니다. 자원 요청·상한·용량은 초기값이며 실제 데이터와 부하에 맞게 조정합니다. DB는 단일 인스턴스이므로 DB 재시작·장애 시에는 서비스 영향이 있습니다. 앱의 RollingUpdate와 DB 고가용성은 별개입니다.

### 소스 및 파일 역할

| 파일 | 역할 |
|---|---|
| `lib/mariadb.js`, `lib/mariadb-store.js` | 연결 풀, DB 공통 잠금, 저장·세션·변경 전 백업 |
| `lib/mariadb-migration.js`, `db/migrations/001-initial.sql` | 스키마 적용과 SQLite/JSON 백업 이전·검증 |
| `lib/client-address.js` | 명시적으로 신뢰한 프록시의 접속 IP만 사용 |
| `Dockerfile`, `.dockerignore` | 실행 파일만 포함하는 비관리자 이미지 |
| `Jenkinsfile`, `k8s/jenkins-agent.yaml` | 테스트, BuildKit 빌드, Harbor 업로드, 앱 순차 교체 |
| `k8s/bootstrap/` | 최초 Namespace·DB·스토리지·권한·통신 범위 구성 |
| `k8s/app.yaml`, `k8s/migration-job.yaml` | 앱과 단일 스키마 작업 템플릿 |
| `k8s/cutover/` | 최초 접속 경로 전환용. Jenkins 자동 배포에서 제외 |
| `scripts/render-k8s.js`, `scripts/prepare-release.js` | 빌드 digest로 템플릿 확정 |
| `scripts/deploy-k8s.sh`, `scripts/prepare-rollback.js`, `scripts/smoke.js` | 배포, 이전 설정 복귀, 서비스 확인 |

### MariaDB 실행과 보존 조건

`DB_CLIENT=mariadb`와 `DB_HOST`, `DB_PORT`(기본 3306), `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `BACKUP_DIR`를 설정합니다. 연결 풀은 앱당 최대 5개로, 배포 중 3개 앱과 스키마·운영 연결의 여유를 DB에 확보합니다. 앱 계정은 SELECT/INSERT/UPDATE/DELETE, 별도 migrator 계정은 해당 DB의 DDL 권한을 갖습니다. 스키마 변경은 앱 시작 시 수행하지 않습니다.

사용자·비밀번호 해시·유효 세션·JSON 원문·ID·그룹 계층·이력을 이전합니다. SQLite NOCASE와 동일하게 ASCII 영문만 접은 이진 키로 중복을 검사합니다. 그룹의 삭제 이력에 따른 자동 증가 번호도 보존합니다. `createApp()`은 비동기 함수로 변경되어 호출부에서 `await`가 필요합니다.

업무 변경은 DB 이름별 공통 잠금으로 여러 앱 사이에서도 직렬화합니다. 입력과 버전을 검사한 다음, InnoDB의 일관된 읽기로 전체 앱 테이블을 JSON 백업하고 파일 동기화·이름 변경이 성공한 뒤 데이터와 이력을 트랜잭션으로 저장합니다. 백업 실패 시 503으로 중단하며 무변경 저장에는 백업을 만들지 않습니다. 로그인·로그아웃은 기존처럼 변경 전 백업 대상이 아닙니다. 이 방식은 소규모 목록에 맞춘 것으로, 데이터가 커지면 매 변경마다 전체 백업하는 비용을 재검토해야 합니다.

백업 파일은 0600이며 웹으로 제공하지 않습니다. 복원은 스키마를 적용한 **빈 DB에만** `scripts/import-mariadb.js --backup ...`으로 수행합니다. 기존 DB에 데이터를 덮어쓰지 않으며 자동 삭제·보존 기간 정책도 추가하지 않았습니다. Ceph 내 백업은 클러스터 전체 장애에 대한 독립 백업이 아니므로 외부 저장소 복사, 용량 알림, 정기 백업과 복원 훈련은 운영 준비 항목으로 남아 있습니다.

`READ_ONLY=true`는 조회와 기존 세션 사용은 허용하면서 로그인·로그아웃·가입·모든 변경 API를 503으로 차단합니다. 최초 데이터 이전 시 기존 SQLite 서비스에 사용합니다. `/livez`는 프로세스, `/readyz`는 스키마·초기화 상태·DB 응답을 검사합니다. SIGTERM은 새 연결 수락을 중단하고 진행 중 요청·DB 연결을 정리하며, Kubernetes 종료 유예는 45초입니다.

`TRUST_PROXY_CIDRS`는 기본 빈 값으로 전달 헤더를 신뢰하지 않습니다. 배포 전 Traefik의 실제 접속 소스 범위를 확인하여 해당 CIDR만 지정합니다. 비워 두면 로그인 제한이 프록시 IP 단위로 합산될 수 있습니다. 아무 IP나 신뢰하는 범위를 넣지 않습니다. NetworkPolicy는 앱 접근을 traefik/jenkins 네임스페이스, DB 접근을 앱/이전 Pod로 제한합니다. CNI 정책 적용과 실제 프록시 경로는 배포 전 확인해야 합니다.

### 최초 기반 준비 — 운영 반영 전 별도 실행

1. 실제 Kubernetes context가 `dev-rke2`인지 확인합니다. `rook-ceph-block`과 `rook-cephfs` 상태·여유 공간, 노드 분산 배치 가능 여부를 확인합니다.
2. Harbor에 비공개 `devurllist` 프로젝트와 `devurllist` 저장소용 로봇 계정을 준비합니다. 빌드용 계정은 Pull/Push, 실행용 계정은 Pull만 허용합니다. 빌드 번호 태그 덮어쓰기를 제한하고 이전 정상 이미지를 보존합니다. `sha-*` 태그는 같은 커밋의 재빌드에서 다시 사용하므로 불변 태그 규칙에 포함하면 업로드가 거절될 수 있습니다. 불변 태그는 삭제도 제한하므로 정리 정책과 함께 결정합니다.
3. `k8s/bootstrap/namespace.yaml`을 적용한 후 아래 Secret을 준비합니다. 실제 값은 저장소·Jenkinsfile·이미지에 넣지 않습니다.

| 네임스페이스 | Secret 이름 | 키/형식 |
|---|---|---|
| devurllist | devurllist-db | `DB_PASSWORD`: 앱 계정 |
| devurllist | devurllist-db-migration | `DB_PASSWORD`: migrator 계정 |
| devurllist | devurllist-db-root | `password`: MariaDB root |
| devurllist | devurllist-harbor-pull | kubernetes.io/dockerconfigjson |
| jenkins | devurllist-harbor-push | kubernetes.io/dockerconfigjson |

예를 들어 권한 0600의 안전한 로컬 파일에서 Secret을 생성합니다. 아래 경로는 실제 파일 경로로 바꾸며 실제 비밀번호를 명령행에 직접 쓰지 않습니다.

```sh
kubectl apply -f k8s/bootstrap/namespace.yaml
kubectl -n devurllist create secret generic devurllist-db --from-env-file=/secure/devurllist-app.env
kubectl -n devurllist create secret generic devurllist-db-migration --from-env-file=/secure/devurllist-migration.env
kubectl -n devurllist create secret generic devurllist-db-root --from-env-file=/secure/devurllist-root.env
kubectl -n devurllist create secret generic devurllist-harbor-pull --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=/secure/harbor-pull.json
kubectl -n jenkins create secret generic devurllist-harbor-push --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=/secure/harbor-push.json
kubectl apply -f k8s/bootstrap/storage.yaml -f k8s/bootstrap/mariadb.yaml -f k8s/bootstrap/rbac.yaml -f k8s/bootstrap/network-policy.yaml
kubectl -n devurllist rollout status statefulset/mariadb --timeout=300s
```

DB 계정 초기화 스크립트는 빈 데이터 볼륨의 최초 시작에만 실행됩니다. 기존 PVC의 비밀번호 변경은 Secret 변경만으로 적용되지 않습니다. 앱 배포 계정에는 StatefulSet·PVC·Secret·Gateway 변경 권한을 주지 않았습니다.

### Jenkins 작업 준비

새 Pipeline 작업 `devurllist-pipeline`에서 Git 저장소 `https://github.com/Revlis44/devUrlList.git`, 브랜치 `*/main`, Script Path `Jenkinsfile`을 지정합니다. 기존 Git 자격증명의 해당 저장소 접근 권한은 별도 확인합니다. 자동 트리거는 이 파일에서 설정하지 않습니다.

기존 `kubernetes` Cloud와 `jenkins` 네임스페이스를 사용합니다. 빌드 Pod에는 Node 24, BuildKit 0.34.2 rootless, 폐기 가능한 MariaDB 테스트 컨테이너가 있습니다. 테스트 DB의 `local-*-test-only` 값은 이 임시 DB 전용이며 실제 DB 자격증명이 아닙니다.

기존 Kaniko 설정을 복사하지 않고 공식 BuildKit rootless 구성을 사용합니다. 해당 컨테이너만 seccomp/AppArmor의 Unconfined와 `--oci-worker-no-process-sandbox`가 필요하므로 실제 노드·Pod 보안 정책과 호환성을 먼저 확인합니다. 호스트 Docker 소켓이나 privileged 컨테이너는 사용하지 않으며 TLS 검증을 끄는 옵션도 없습니다. 내부 HTTPS 검증에는 기존 Jenkins 파일 자격증명 `sayinfo-local-root-ca-v2-crt`를 사용합니다.

빌드 파라미터 없이 매 실행마다 테스트 → 이미지 빌드·Harbor 업로드 → DB 스키마 작업 → Rancher 앱 순차 교체 → 내부 Service·실제 HTTPS 도메인 검증을 진행합니다. 앞 단계가 실패하면 다음 단계로 진행하지 않습니다. 이 작업은 데이터 이전과 도메인 전환이 완료된 환경의 반복 배포용입니다.

일반 배포 순서는 다음과 같습니다.

1. 소스 수정과 로컬 테스트를 완료하고 `main`에 커밋·푸시합니다.
2. Jenkins의 `devurllist-pipeline`에서 빌드를 실행합니다. 기존 작업 화면에 이전 선택 항목이 남아 있어도 해당 값은 사용하지 않으며, 변경된 Jenkinsfile로 실행하면 전체 배포를 진행합니다.
3. Jenkins `Finished: SUCCESS`, Rancher 앱 Ready 2/2, 실제 도메인의 로그인과 변경한 기능을 확인합니다.

테스트·이미지 빌드만 필요한 경우 아래 로컬 검증 절차를 사용합니다. Jenkins에서는 Harbor 인증 정보가 없으면 실패하며, 업로드나 배포를 건너뛰는 옵션은 제공하지 않습니다.

최초 배포에서 기존 앱 리소스 조회 결과가 비어 있으면 복원 대상이 없는 것으로 처리하고 스키마 작업과 앱 배포를 진행합니다. 비어 있지 않은 조회 결과가 올바른 JSON이 아니면 배포를 중단합니다.

동시 빌드는 대기시키며, 하나의 이미지에 `sha-<커밋12자리>`와 `<빌드번호>` 두 태그를 붙여 Harbor에 업로드합니다. 예를 들어 Jenkins #6이면 `sha-6a71a2d68558`, `6`이 같은 이미지를 가리킵니다. 같은 커밋을 다시 빌드하면 SHA 태그는 이번 빌드의 이미지를 가리키고, 이전 빌드는 해당 빌드 번호 태그로 구분합니다. 배포에는 이번 빌드에서 반환된 digest를 사용합니다.

기존 앱 설정을 보관하고 단일 스키마 Job이 성공한 뒤 앱을 적용합니다. 배포·상태 검증 실패 시 이전 ConfigMap·Service·PDB·Deployment를 복원하며 DB 스키마는 되돌리지 않습니다. 최초 배포에는 이전 앱이 없어 자동 복귀 대상이 없습니다. Jenkins 실행 Pod 소실·강제 중단처럼 복귀 코드를 실행할 수 없는 경우는 운영자 복구가 필요합니다. readiness 실패·이미지 Pull 실패·DB 장애 시 실제 복귀 동작은 클러스터 배포 연습에서 확인해야 합니다.

스키마 변경은 반드시 현재 앱과 이전 앱 모두에 호환되게 추가하고, 컬럼 삭제·타입 축소는 후속 릴리스에서 수행합니다. HTTP smoke 검증은 상태·정적 페이지·인증 필요 여부를 확인하며 실제 사용자 로그인 시험을 대신하지 않습니다. `PDB minAvailable=1`은 자발적인 축출에 대한 정책이며 RollingUpdate는 Deployment 설정으로 제어합니다.

### SQLite 최종 이전 및 접속 전환

아래는 새 환경의 최초 이전을 위한 별도 운영 절차입니다. 현재 Jenkins 작업은 업로드·배포·도메인 검증을 분리하지 않으므로, 최초 이전의 이미지 준비와 전환 전 앱 검증에는 사용하지 않습니다. 반복 배포에서는 이 절차를 다시 실행하지 않습니다.

1. SQLite 복사본으로 이전·복원 연습과 소요 시간을 측정합니다. 운영 DB를 테스트 DB로 사용하지 않습니다.
2. 새 이미지 업로드까지만 수행합니다. 기존 SQLite 서비스에 이 버전의 읽기 전용 기능을 먼저 반영한 후 `READ_ONLY=true`로 기동하고, 모든 쓰기 요청이 차단되는지 확인합니다. 이 준비 버전 반영 자체도 별도 배포 작업입니다.
3. 진행 중 요청을 완료한 뒤 SQLite 백업 API로 일관된 최종 스냅샷을 만듭니다. 실행 중인 DB 본체만 복사하여 WAL 내용을 누락하지 않습니다. 기존 코드·환경·DB 백업을 별도로 보존합니다.
4. 안전한 로컬 관리 경로에서 `kubectl -n devurllist port-forward service/mariadb 13317:3306`으로 연결하고, migrator 계정 설정 파일(DB_HOST=127.0.0.1, DB_PORT=13317, DB_NAME=devurllist, DB_USER=devurllist_migrator, DB_PASSWORD)을 사용합니다.

```sh
npm ci --ignore-scripts
node --env-file=/secure/devurllist-migrator.env scripts/migrate-mariadb.js
node --env-file=/secure/devurllist-migrator.env scripts/import-mariadb.js --sqlite /secure/final-sites.sqlite
```

이전 도구는 대상이 비어 있는지 검사하고, 행 수와 각 컬럼 값의 해시를 비교하며, 실패한 행 삽입은 롤백합니다. 외래 키와 그룹 순환·존재 여부도 검사합니다. 자동 증가 번호의 설정은 빈 대상에서 먼저 수행되므로 실패 후 재시도할 수 있습니다. 이 도구는 가동 중인 두 DB를 동기화하는 도구가 아닙니다.

5. 데이터 검증 후 앱을 배포하고 내부 Service에서 로그인·조회·변경·백업을 검증합니다. 새 DB 쓰기를 시험했다면 이전 SQLite로 단순 복귀할 수 없으므로 시험 데이터 범위와 복구 기준을 미리 정합니다.
6. 기존 `traefik/devurl` HTTPRoute의 전체 YAML을 보관하고 변경 직전 내용을 다시 확인합니다. Gateway API의 ReferenceGrant 버전과 Traefik 지원 여부를 확인한 뒤에만 아래 파일을 적용합니다. 이 패치는 기존 rules 전체를 대체하므로 현행 규칙이 준비 당시와 다르면 조정합니다.

```sh
kubectl apply -f k8s/cutover/referencegrant.yaml
kubectl -n traefik patch httproute devurl --type=merge --patch-file=k8s/cutover/route-patch.json
```

도메인·TLS·Gateway listener는 유지하고 backend만 `devurllist/devurllist:3000`으로 전환합니다. Accepted/ResolvedRefs와 실제 HTTPS 응답을 확인합니다. 새 MariaDB에 사용자 쓰기가 발생한 이후에는 이전 SQLite로 경로만 되돌리지 않습니다. 같은 MariaDB와 호환되는 이전 앱 이미지를 사용하거나 쓰기를 중지하고 데이터를 조정해야 합니다. 최초 이전은 쓰기 중지 구간이 있으며, 이후 앱 배포부터 순차 교체 정책을 사용합니다.

### 로컬 검증

```sh
npm ci --ignore-scripts
npm test
docker compose -f docker/compose.test.yaml up -d --wait
npm run test:mariadb
docker compose -f docker/compose.test.yaml down
docker build -t devurllist:local-test .
```

통합 테스트는 기본 `127.0.0.1:13316/devurllist_test`를 사용하고 알려진 테스트 테이블을 삭제·재생성합니다. 로컬 주소와 `devurllist_*test` 이름만 허용합니다. Jenkins에서는 같은 Pod의 임시 `devurllist_ci_test`를 사용합니다. 외부 DB 주소나 운영 DB 이름을 넣으면 실행을 거절합니다.

공식 참고: [MariaDB Node.js](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/connector-nodejs-promise-api), [MariaDB GET_LOCK](https://mariadb.com/docs/server/reference/sql-functions/secondary-functions/miscellaneous-functions/get_lock), [BuildKit rootless](https://github.com/moby/buildkit/blob/master/docs/rootless.md), [Kubernetes Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [Gateway ReferenceGrant](https://gateway-api.sigs.k8s.io/reference/api-types/referencegrant/).
