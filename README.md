# 담소 도구함 · Damso Tools

SillyTavern 개인용 한국어 편의 확장과 같은 프로세스에서 실행되는 서버 플러그인입니다.

기준 커밋 `2f3a221e00dd713baba45e1f857d093141593c09`의 기능을 기반으로 합니다.
지원 호스트: **SillyTavern 1.18.0 / 1.19.0**, 직접 실행 또는 Docker 파생 이미지.

## 직접 실행 환경 설치

[통합 설치 ZIP 다운로드](https://github.com/mallang0723/ST_FE_Tool/raw/refs/heads/main/downloads/damso-tools-0.1.0.zip) · [SHA-256 확인](https://github.com/mallang0723/ST_FE_Tool/blob/main/downloads/SHA256SUMS)

다운로드한 ZIP을 풀고 `damso-tools-0.1.0` 폴더에서 설치 명령을 실행합니다.

SillyTavern에 대상 사용자로 한 번 접속한 뒤 서버를 종료합니다. SillyTavern을 실행하는 계정으로 통합 ZIP을 별도 폴더에 풀고 다음을 실행합니다.

```sh
node install.mjs diagnose --root /path/to/SillyTavern --user default-user
node install.mjs install --root /path/to/SillyTavern --user default-user
```

실제 설정 파일이 다른 곳에 있으면 `--config /path/to/config.yaml`, 실행 시 데이터 경로를 덮어썼다면 `--data-root /path/to/data`를 지정합니다.
직접 실행 검증 환경은 Linux입니다. Windows/macOS는 아직 검증하지 않았습니다. 경로에 공백이 있으면 따옴표로 묶습니다.
설치 후 SillyTavern을 한 번 재시작하고 확장 설정의 **담소 도구함 → 내장 서버**에서 서버·저장소·초기 연결 버전을 확인합니다.
UI 확장 설치 버튼만으로는 서버 연결이 설치되지 않습니다.

설치 도구는 호스트 해시를 먼저 검사합니다. 수정된 호스트 파일이면 아무것도 덮어쓰지 않습니다.
서버 플러그인 사용만 활성화하며 전역 플러그인 자동 업데이트 정책은 바꾸지 않습니다.

## 업데이트와 복구

업데이트는 서버 종료 후 새 ZIP의 같은 설치 명령으로 실행합니다. 원본 Git 저장소로 자동 업데이트하지 않습니다.
호스트 자체 버전을 바꾸기 전에는 기존 설치를 복구한 뒤 호스트를 업데이트하고 다시 설치합니다.

```sh
node install.mjs uninstall --root /path/to/SillyTavern --user default-user
```

패키지가 설치한 파일만 되돌리며 `data/<사용자>/st-ko-tools`의 보관함·백업·작업 기록은 보존합니다.
설치 이후 대상 파일을 직접 수정했다면 충돌을 보고하고 중단합니다. 원본 사본은 `.damso-install/originals`에 남습니다.

전원 종료 등으로 설치가 중단되어 `pending.json`이 남았다면 `uninstall` 대신 아래 명령으로 설치 전 원본을 복구한 뒤 다시 설치합니다.

```sh
node install.mjs recover --root /path/to/SillyTavern --user default-user
```

## Docker

기존 SillyTavern에서 대상 사용자로 한 번 접속해 사용자 데이터 폴더를 만든 뒤 중지합니다.
통합 ZIP을 푼 폴더에서 기존 이미지와 같은 버전을 기반으로 빌드합니다.

```sh
docker build -f docker/Dockerfile --build-arg ST_IMAGE=ghcr.io/sillytavern/sillytavern:1.19.0 -t damso-st:1.19.0 .
```

기존 서비스의 `image`만 이 이미지로 바꾸고 `DAMSO_USER`에 사용자 핸들을 지정합니다. 기존 config/data/plugins/extensions 볼륨과 포트를 유지합니다.
초기 연결·호스트 패치는 이미지에, 사용자 확장·서버 모듈은 시작 시 기존 볼륨에 설치됩니다. 새 백엔드 컨테이너는 없습니다.
1.18.0은 해당 버전의 이미지로 빌드합니다. 커스텀 이미지의 소스가 기준 해시와 다르면 빌드가 중단됩니다.
복구는 중지한 서비스의 동일 볼륨을 임시 컨테이너에 연결해 `node /opt/damso-tools/install.mjs uninstall --container-runtime --root /home/node/app --config config/config.yaml --user <사용자>`를 실행한 뒤 원래 이미지로 돌아갑니다.

## 개발

Node.js 24, npm, Python 3(배포 ZIP 생성)으로 빌드합니다.

```sh
npm ci
npm test
npm run build
npm run package
```

실행 산출물은 `dist/index.js`, 설치 묶음은 `release/damso-tools-0.1.0.zip`입니다.
SillyTavern 내부에서 실행하는 확장이므로 별도 Vite 개발 서버는 사용하지 않습니다.
서버 API는 로그인·CSRF가 적용되는 `/api/plugins/st-ko-tools/v1`에 등록됩니다.
서버는 인증된 사용자 디렉터리를 사용하며 클라이언트의 사용자명·절대 경로를 신뢰하지 않습니다.

클라우드용 테스트 호스트는 `node scripts/setup-hosts.mjs`로 `.host/1.18.0`, `.host/1.19.0`에 준비합니다. 이 명령 전에 두 테스트 서버를 종료하세요. 소스와 의존성을 내려받으므로 인터넷 연결이 필요합니다. 실행·검증 명령은 `docs/VALIDATION.md`에 있습니다.

## 기능 범위

- 한국어 설정·메시지 관리자·프리셋 그룹/즐겨찾기·정규식·세계관 설정집·코드미러·모바일 조작
- revision 충돌 검사 공용 보관함, 메모 보호 프리셋 백업, 기본 일반 백업 합계 200개
- 설정·목록 캐시, 매니페스트 묶음, 테마 지연 로딩, 호스트 토큰 집계 재사용
- OpenAI/Custom 단일 캐릭터 normal/regenerate, n=1 백그라운드 생성·저장
- 일반 도구 호출·그룹·계속·swipe는 기본 생성으로 전환. `emit_complete_response` 단일 도구만 별도 허용
- 생성 결과가 충돌하면 작업 기록에 보존. 알 수 없는 작업은 재요청하지 않고 조회. 브라우저 종료 후 문구 재생성은 지원하지 않음
- 분할 채팅 로딩은 계속 비활성. Tab 탐색 제한과 원본 채팅 복구 보조는 기본 끔

실제 확인한 범위와 미실시 항목은 `docs/VALIDATION.md`, 변경 내용은 `docs/CHANGES.md`에 기록합니다.
원본 작성자와 vendor 고지는 보존합니다. 기존 저장소의 LICENSE는 유지하며 원본 확장에 없던 라이선스를 추정해 부여하지 않습니다.
