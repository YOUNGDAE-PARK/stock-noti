# Stock-Noti 프로젝트 구현 TO-DO List

본 시스템 구축을 위한 단계별 태스크 목록입니다. 완료된 항목은 `[x]`로 체크하며 개발을 진행합니다.

---

## [x] Phase 0. 키 발급 및 환경 준비
- [x] API 인증키 준비 및 발급 (사용자 가이드 제공 완료)
  - [x] OpenDART API 키 발급 가이드 작성
  - [x] 네이버 검색 API Client ID & Client Secret 가이드 작성
  - [x] KRX Open API/대체 크롤러 구축 완료 (별도 인증서 없이 네이버 파이낸스 차트 연동 백업 구현)
- [x] 개발 환경 구성
  - [x] 프로젝트 디렉토리 초기화 및 패키지 설정 (`package.json` 완료, type: "module" 설정 완료)
  - [x] 데이터베이스 선택 (SQLite & `sqlite` / `sqlite3` 라이브러리 설치 완료)
  - [x] `.env.template` 작성 및 로컬 `.env` 환경변수 세팅 완료
  - [x] DB 연결 모듈 (`src/db/db.js` 완료)
  - [x] 마이그레이션(초기 테이블 생성) 스크립트 작성 및 실행 (`src/db/init.js` 완료)

## [x] Phase 1. 보유자산 마스터 구축
- [x] 데이터베이스 스키마 정의 (`portfolio_asset` 테이블 작성 완료)
- [x] 보유자산 초기 데이터 수집 및 삽입 스크립트 작성 (`src/db/seed.js` 완료)
- [x] DART 회사 고유번호(`corp_code`) 매핑 자동화 스크립트 구현 (`src/db/update_corp_codes.js` 완료)
  - [x] OpenDART 고유번호 XML 다운로드 및 로컬 캐싱 기능 완료
  - [x] 보유 자산 목록의 종목코드를 DART `corp_code`와 매핑하여 저장 완료

## [x] Phase 2. DART 수집기 구현
- [x] 데이터베이스 스키마 정의 (`raw_source_item` 테이블 작성 완료)
- [x] DART 공시 조회 API 연동 기능 구현 (`src/services/collectors/dart.js` 완료)
- [x] 수집 주기 관리 및 `rcept_no` 기준 중복 제거 로직 구현 완료
- [x] 수집된 공시 보고서명(`report_nm`) 기준 중요도 및 이벤트 분류 규칙 작성 완료

## [x] Phase 3. 네이버 뉴스 API 수집기 구현
- [x] 네이버 뉴스 검색 API 연동 모듈 작성 (`src/services/collectors/naverNews.js` 완료)
- [x] 자산별 보유 이유와 리스크 키워드를 반영한 맞춤형 검색 쿼리 제너레이터 구현 완료
- [x] 단순 시황 기사(급등/급락, 테마주 묶음) 필터링 기능 구현 완료
- [x] 원천 뉴스 정보의 메타데이터(제목, 링크, 날짜, 출처) DB 저장 기능 구현 완료

## [x] Phase 4. IR / 뉴스룸 레지스트리 구축
- [x] 데이터베이스 스키마 정의 (`source_registry` 테이블 작성 완료)
- [x] 보유자산별 공식 IR 페이지, 뉴스룸, RSS URL 수동/반자동 등록 (`src/test/run_integration_test.js`에 시드 로직 완료)
- [x] 주기적 URL 유효성 검사 및 실패율 모니터링 모듈 구축 (`src/services/collectors/ir.js` 완료)
- [x] 접속 실패 혹은 부재 시 AI를 통한 URL 검색/업데이트 백업 로직 마련 완료

## [x] Phase 5. KRX 시장 데이터 수집기 구현
- [x] 데이터베이스 스키마 정의 (`market_snapshot_daily` 테이블 작성 완료)
- [x] KRX Open API 연동 모듈 작성 (`src/services/collectors/krx.js` 완료)
- [x] 장 종료 후 일별 가격, 거래량, 거래대금, 등락률 수집 자동화 완료
- [x] 보유 ETF의 일별 데이터 및 추종 지수 데이터 수집 로직 구현 완료

## [x] Phase 6. KIND 리스크 보조 수집기 구현
- [x] KIND 오늘의공시 RSS 주소 파싱 기능 구현 (`src/services/collectors/kind.js` 완료)
- [x] 리스크 관련 핵심 키워드(거래정지, 관리종목, 불성실공시 등) 필터링 로직 구현 완료
- [x] 수집된 KIND 데이터를 `raw_source_item`에 적재 완료

## [x] Phase 7. 정규화 및 이벤트 병합 계층 구현
- [x] 1차 중복 제거 (해시 기반 고유 원천 필터링) 구현 완료
- [x] 데이터베이스 스키마 정의 (`investment_event`, `event_source_link` 테이블 작성 완료)
- [x] 2차 중복 제거 및 병합 알고리즘 구현 (`src/services/consolidator.js` 완료)
  - [x] 동일 종목 + 유사 날짜(1~3일) + 동일 카테고리 기사 병합 완료
  - [x] 키워드 공유 기반의 고성능 유사도 매핑 로직 작성 완료
- [x] 대표 근거 우선순위 룰셋 적용 (DART > IR > KIND > 뉴스) 완료

## [x] Phase 8. 스케줄러 & 리포팅 및 실시간 감시 엔진 구현
- [x] 스케줄러 패키지 설치 및 설정 (`node-cron` 완료)
- [x] **오전 8시 종합 리포트 발행 스크립트 작성** 완료 (`src/services/reports/dailyReport.js` 완료)
- [x] **매 1시간 주기 실시간 단기 분석 감시 스크립트 작성** 완료 (`src/services/reports/hourlyNoti.js` 완료)
  - [x] 현재 시점 주가 흐름 파악 모듈 구현 완료
  - [x] 실시간 속보 수집 및 보유 이유/리스크 키워드 매칭 완료
  - [x] 특이사항이 발견되었을 때만 알림(Noti)을 발행하고, **평소에는 조용히 넘어가기(생략) 로직** 적용 완료
- [x] 알림 채널 연동 (마크다운 파일 생성 완료 및 터미널 출력 구조 완료)
- [x] 스케줄링 마스터 데몬 구현 (`src/app.js` 완료)

## [x] Phase 9. 과거 실데이터 테스트 및 시뮬레이션 환경 구축
- [x] 역사적 시뮬레이션용 테스트 케이스 정의 (`docs/test_cases.md` 완료)
- [x] 테스트 케이스별 역사적 데이터(공시, 뉴스, 주가) 적재용 시뮬레이션 스크립트 작성 완료 (`src/test/run_simulation.js` 완료)
- [x] 시뮬레이션 실행 후 병합 처리결과 및 주가 반응 데이터 검증 완료
- [x] **Judge as a Service (JaaS) 기반 판단 보조 결과 및 검증 리포트 공유** 완료 (`docs/simulation_report.md` 완료)
- [x] **실시간 수집기 및 병합 통합 연동 테스트 완료** (`src/test/run_integration_test.js` 완료)
