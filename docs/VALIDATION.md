# 담소 도구함 0.1.0 검증 기록

검증일: 2026-10-07. 사용자의 **직접 실행·Docker, 1.18.0·1.19.0** 조건을 반영했다. 실제 사용자 설치 경로와 모델 인증 정보는 제공되지 않아, 별도 테스트 데이터로 구성한 Linux 호스트에서 확인했다. 이 검증 당시에는 개인용 파일만 만들었으며 원격 저장소에 게시하거나 푸시하지 않았다.

2026-10-09: 사용자 요청에 따라 README를 수정하고 GitHub 설치용 ZIP을 `downloads/`에 추가했다. 다운로드 링크는 README에 안내한다. 아래 기능 검증 결과는 2026-10-07에 수행한 기록이다.

## 기준과 변경 파일

- 원본 확장: `2f3a221e00dd713baba45e1f857d093141593c09`, package/manifest 1.0.0. 원본 README의 0.30.13 표기와 구분한다. 작성자 柏柏, vendor 고지, 기존 저장소 LICENSE를 유지했다.
- SillyTavern 1.18.0: `51ad27fb86d39a3daca3adaa970375c9670c12df`.
- SillyTavern 1.19.0: `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.
- 직접 실행: Node 24.19.0, npm 11.9.0. Docker: 해당 버전의 공식 GHCR 이미지를 기반으로 파생 이미지 빌드.
- `src/`: 원본 기능 모듈을 유지하고 한국어 문구, 자체 서비스 계약, 생성 연결을 변경했다. 설정 키 `baiBaiToolkit`, 프리셋 키 `baibaiToolkit`, 사용자 본문·정규식·식별자를 보존한다.
- `server/`, `shared/`: 사용자별 파일 저장소, revision, 백업, 캐시, 네이티브 호스트 어댑터, 영속 작업 관리기.
- `integration/`: 초기 fetch 연결, 공유 채팅 잠금, 버전별 원본·패치 해시와 정확한 편집 위치.
- `installer/`, `docker/`, `scripts/build-package.mjs`: 직접 설치·업데이트·제거·중단 복구, 파생 이미지, 소스 포함 통합 ZIP.

## 실제 통과한 확인

| 확인 | 환경·결과 |
|---|---|
| 빌드·정적 검사 | Vite production 빌드, Node 구문, 외부 BaiBaoKu URL·브리지 의존성 제거, 패키지 버전 일치 |
| 자동 회귀 검사 | 핵심 16개, 생성 재시도 111개, 백업 정리 22개, 합계 149개 통과. 아래 명령으로 재현 |
| 직접 실행 API | 1.18.0·1.19.0에서 상태·설정 응답·테마·확장 순서·네이티브 토큰 결과·보관함 revision·백업·검색·생성·중복 방지·저장 표식·낡은 저장 차단·취소·CSRF 확인 |
| Docker API | 1.18.0·1.19.0 파생 이미지와 config/data/plugins 볼륨으로 동일 검사를 통과. 1.19.0은 PUID/PGID=1000 실행도 확인 |
| 실제 Chromium 생성 UI | 두 버전 모두 normal, regenerate, 503 뒤 한 번 재시도, 창 닫기 뒤 서버 저장·재접속, 중단, 한국어 상태 화면·작업 기록 확인. pageerror 없음 |
| 설치·복구 | 두 버전에서 새 설치·같은 패키지 재설치·진단·원본 해시 복구·설치 후 다른 설정 보존·사용자 데이터 보존·수정된 호스트 거부·pending journal 복구 확인 |
| 화면 | 1440px 및 390px에서 확장 설정을 확인. 초기 번역 화면의 버튼 줄바꿈을 수정 |
| 메시지·테마 UI | 두 버전에서 65개 기록 유지, 30개 페이지, 편집 취소·저장·현재 swipe 동기화·재접속, 정상 삭제 보존·읽기 실패 복원, 네이티브 테마 적용 확인 |
| 소스 재빌드 | ZIP의 source 폴더에서 npm ci와 package 성공. 생성된 dist/index.js SHA-256이 작업 공간 빌드와 일치 |

API 및 브라우저 생성 검사는 **로컬 모의 OpenAI 형식 공급자**를 실제 SillyTavern Custom 생성 핸들러에 연결했다. 유료 모델 호출이나 실제 API 키 연결 성공을 뜻하지 않는다. 서버를 대신한 가짜 드라이버를 제품에 넣지 않았다.

## 기능별 구현과 확인 범위

‘원본 유지’는 해당 구현을 가져와 한국어화하고 빌드한 상태를 뜻한다. 브라우저 검증을 수행했다는 뜻과 구분한다.

| ID | 주요 파일 | 구현·확인 및 남은 범위 |
|---|---|---|
| F01 | `src/chat/longChatRender.js` | 원본 content-visibility·최근 메시지 예외 유지. 대규모 채팅 스크롤 성능 수치 미측정 |
| F02 | `src/chat/settingsBind.js` | 초기 표시량 제한 원본 유지. 전체 chat 배열을 잘라 저장하는 코드로 바꾸지 않음 |
| F03 | `src/chat/welcomeRecent.js`, `completionScroll.js` | 최근 채팅 직접 열기·완료 스크롤 유지. 빠른 연속 전환 체감 측정 미실시 |
| F04 | `src/chat/chatList.js`, `src/features/fastChat.js` | 자체 목록 경로·원래 경로 폴백. 실제 호스트 검색 응답 일치 확인 |
| F05 | `src/chat/mobileKeyboard.js` | 원본 모바일 초점·리사이즈 처리 유지. 모바일 폭 확인, 실제 iOS/Android IME·절전 미실시 |
| F06 | `src/chat/tripleClickEdit.js`, `deleteEditFlow.js`, `editBottomActions.js` | 상호 배타적 빠른 편집·확인/취소 유지. 모든 생성 전 편집 조합 수동 확인은 남음 |
| F07 | `src/floorDirectory.js` | 한국어 검색·30개 페이지·편집 저장/취소·swipe 동기화·재접속 확인. 숨김·범위 삭제는 원본 유지, 전체 조합 검증은 남음 |
| F08 | `src/features/reloadGuard.js`, `integration/early-bridge.js` | 기본 끔. 같은 채팅의 실제 읽기 실패를 확인한 경우만 화면 스냅샷 복원. 성공한 짧은 읽기는 정상으로 취급하며 force-save 제거. 읽기 성공 전 덮어쓰기 차단 검사 추가 |
| F09 | `src/features/gzipHook.js` | 공개 주소만 압축하는 원본 정책 유지, revision 헤더 연결. 공개 HTTPS·리버스 프록시 압축 왕복 미실시 |
| F10 | `src/features/miscPatches.js` | 원본 번역 확장 후처리 조건 유지. 외부 번역 확장 조합 미실시 |
| F11 | `src/features/characterList.js` | 원본 아바타 지연 로딩·조합 입력·검색 지연 유지. 실제 모바일 조합 입력 미실시 |
| F12 | `src/preset/switchFast.js`, `tokenizer.js`, `saveToggle.js` | 프리셋 전환·지연 집계·저장 유지. 자체 토큰 결과를 네이티브와 비교 |
| F13 | `src/preset/groupState.js`, `vueDrag.js`, `dragCustom.js` | 원본 그룹·모바일 드래그·실행 순서 유지. 실제 터치 길게 누르기 미실시 |
| F14 | `src/preset/favorites.js` | 원본 항목 참조 즐겨찾기 유지. 복제 프롬프트를 추가하는 변경 없음 |
| F15 | `src/preset/globalLibrary.js`, `src/backend/client.js`, `server/services/library.mjs` | 자체 보관함, 사용자 분리, expectedRevision 충돌, 항목의 알 수 없는 필드 보존 검사 |
| F16 | `src/features/regex*.js` | 원본 범위·그룹·드래그·일괄 작업 유지. 모든 범위 이동 조합의 실제 데이터 재접속 검증은 남음 |
| F17 | `src/worldinfo/` | 원본 식별자·필드·지연 Select2·Vue 목록 유지. 대형 설정집 비교 미실시 |
| F18 | `src/worldinfo/searchReplace.js` | 원본 일반 문자열 치환·횟수 확인·saveWorldInfo 유지. 본문과 항목명 조합별 브라우저 검증은 남음 |
| F19 | `src/preset/codeMirror.js`, `src/features/descEditor.js` | 원본 코드미러·textarea 폴백 유지. 모든 확대/취소 경로의 실기 검증은 남음 |
| F20 | `src/features/customCss.js`, `theme.js` | 원본 CSS 접근자 복원·테마 재동기화 유지. 다른 테마 관리 확장과의 조합 미실시 |
| F21 | `src/chat/completionSound.js` | 원본 음원·URL·로컬 파일·최종 알림 조건 유지. 생성 회귀 검사, 실제 휴대폰 백그라운드 음원 재생 미실시 |
| F22 | `src/features/generateRetry.js`, `saveGenerate.js` | 원본 일시 오류 처리·공유 횟수. 실제 브라우저에서 확정 503 뒤 한 번 재시도 확인 |
| F23 | `src/features/generateBlacklistRetry.js` | 원본 문자열·정규식·공유 횟수·중단 생명주기 회귀 검사. 브라우저 종료 후 문구 재생성은 지원하지 않음 |
| F24 | `server/jobs/manager.mjs`, `src/features/saveGenerate.js` | 실제 네이티브 Custom 핸들러, idempotency, 잠금·revision, 취소, 충돌 결과 보관, 재시작 표식 복구. 실제 모델 및 emit_complete_response의 전체 브라우저 흐름 미실시 |
| F25 | `integration/early-bridge.js`, `server/services/cache.mjs` | 첫 설정 요청 전 연결·캐시. 원래 설정 응답 키 보존, 실패 시 원래 경로 |
| F26 | `server/index.mjs`, `integration/early-bridge.js` | 네이티브 발견 순서 그대로 매니페스트 묶음. 두 버전에서 비교 |
| F27 | `server/index.mjs`, `src/features/fastBootstrap.js` | 캐릭터·최근 채팅 목록 네이티브 핸들러 재사용, 파일 변경으로 무효화 |
| F28 | `src/features/theme.js`, 호스트 `power-user.js` 패치 | 선택 테마 보존·지연 테마 복원·네이티브 applyTheme 사용. 토글을 꺼도 이미 받은 자리표시자는 복원 |
| F29 | `src/preset/tokenizer.js`, `server/index.mjs` | 항목 ID·모델별 네이티브 집계. 한국어 텍스트의 원래 API 결과 및 순서 일치 |
| F30 | `src/preset/autoBackup.js`, `backupPreview.js`, `server/services/backups.mjs` | 저장 성공 뒤 백업·전체 원본 payload·이름·메모·가져오기 UI 연결. 서버 백업 왕복 검사 |
| F31 | `src/preset/backupRetention.js`, `server/services/backups.mjs` | 일반 백업 전체 합계 기본 200, 메모 보호·개수 제외, 서버 정리 잠금. 손상 메타데이터 시 삭제 중단 검사 |
| F32 | 호스트 `keyboard.js` 패치 | 기본 끔, 기존 선택은 유지. 켜면 메시지 Tab 탐색 제한, 새로고침부터 적용. 보조공학 실사용 검증 미실시 |
| F33 | `src/features/updateCheck.js`, `settingsPanel.js` | 상태·기능별 토글 유지. 원본 Git 자동 업데이트 대신 개인용 ZIP 설치 도구로 갱신 |

따라서 **33개 기능의 모든 실사용 완료 조건을 검증했다고 표시하지 않는다.** 원본에서 계승한 편집·드래그·외부 확장 조합과 실제 기기 항목은 표에 남겼다. 분할 채팅 로딩은 비활성 상태다.

## 재현 명령

테스트 명령은 실제 사용자 데이터가 아닌 `.host/`의 복제 호스트에서 실행한다. 호스트 초기화·설치 전에 해당 서버를 종료한다.

```sh
npm ci --cache /tmp/damso-npm-cache
npm run check
npm test
npm run test:generate-retry
npm run test:preset-backup-retention
npm run package
node scripts/setup-hosts.mjs
node scripts/smoke-installer.mjs .host/1.19.0
node scripts/smoke-installer.mjs .host/1.18.0
```

별도 터미널에서 `.host/1.19.0`의 `node server.js --port 18019 --listen false --autorun false`, `.host/1.18.0`의 동일 명령 `--port 18018`로 실행한다.

```sh
node scripts/smoke-host.mjs http://127.0.0.1:18019
node scripts/smoke-browser.mjs http://127.0.0.1:18019
node scripts/smoke-ui.mjs http://127.0.0.1:18019
```

1.18.0은 포트를 18018로 바꾼다. 브라우저 스크립트는 환경의 Playwright/Chromium을 사용하며 다른 환경에서는 `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`로 경로를 지정한다. 생성 요청은 로컬 모의 공급자만 사용한다. Docker 테스트에서는 `DAMSO_FIXTURE_BIND=0.0.0.0`, `DAMSO_FIXTURE_HOST=<테스트 Docker 게이트웨이>`로 모의 공급자를 연결한다. 제품 설치에는 이 공급자나 추가 포트가 필요 없다.

## 제한과 미실시

- Linux와 공식 Docker 이미지에서 검증했다. Windows/macOS 직접 실행, 사용자 커스텀 호스트 수정본은 검증하지 않았다. 패치 해시가 다르면 설치가 중단된다.
- 실제 모델 자격 증명, 모바일 기기 IME·음원·터치, 다른 설치 확장들과의 충돌, 성능 수치 비교는 미실시다.
- 초기 번들 크기는 원본과 같은 단일 번들 구조로 Vite 권고 500KB를 넘는다. 빌드는 성공하며 크기 개선 수치를 주장하지 않는다.
- 새 클라우드 태스크에서 스냅샷 복원은 별도 작업이므로 이번 세션에서 검증하지 않았다. 설정 초안 저장과 환경 게시를 구분한다.

## 원본 테스트 이관

`scripts/test-generate-blacklist-retry.mjs`의 재시도·패턴·중단·알림 생명주기 검사는 유지했다. 제거된 BaiBaoKu 작업 계약에 고정된 VM harness 검사는 새 작업 관리기 검사와 실제 호스트·브라우저 검사로 교체했다. 한국어 로그·토스트 기대값만 번역에 맞춰 바꿨으며 정규식·사용자 문자열의 테스트 값은 보존했다. 백업 정리 검사에는 자체 config/prune 계약을 반영했다. 원본 파일은 기록한 upstream 커밋에서 재확인할 수 있다.
