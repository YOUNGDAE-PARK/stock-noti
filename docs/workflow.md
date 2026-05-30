# Stock-Noti 프로젝트 기본 워크플로우

이 시스템의 핵심 동작 흐름을 시각화한 다이어그램입니다. 지정된 스케줄러(오전 8시 종합 리포트 및 매시간 단기 감시 루프)에 따라 작동합니다.

---

## 1. 전체 데이터 파이프라인 흐름

```mermaid
graph TD
    %% 데이터 수집 소스
    subgraph Sources ["수집 원천 (Data Sources)"]
        DART["DART 공시 API (우선순위 1)"]
        IR["기업 IR / 뉴스룸 (우선순위 2)"]
        KIND["KIND RSS / 리스크 공시 (우선순위 3)"]
        NEWS["네이버 뉴스 API (우선순위 4)"]
        KRX["KRX Open API (가격 / 거래량)"]
    end

    %% 수집 및 정규화 계층
    subgraph Normalize ["정규화 계층 (Normalization Layer)"]
        Mapper["종목코드/날짜 통일"]
        Deduplicator1["1차 중복 제거 (URL & 제목 해시 비교)"]
        Mapper --> Deduplicator1
    end

    %% 이벤트 병합 및 분석
    subgraph Consolidation ["이벤트 병합 & 판단 계층"]
        Deduplicator2["2차 이벤트 병합 (유사도 및 1~3일 기간 매핑)"]
        SignalGen["판단 보조 신호 생성 (보유이유 대조)"]
        Deduplicator2 --> SignalGen
    end

    %% 리포트 및 대시보드 출력
    subgraph Output ["출력 계층 (Output)"]
        DailyReport["오전 8시 종합 리포트"]
        ShortTermNoti["단기 속보 알림 (특이사항 발생 시에만)"]
        WeeklyRebalance["주간 리밸런싱 후보 목록"]
    end

    %% 연결 관계
    DART --> Mapper
    IR --> Mapper
    KIND --> Mapper
    NEWS --> Mapper
    KRX --> Mapper

    Deduplicator1 -->|"정규화된 raw_source_item"| Deduplicator2
    SignalGen --> DailyReport
    SignalGen --> ShortTermNoti
    SignalGen --> WeeklyRebalance
```

---

## 2. 시간별 스케줄 및 운영 흐름 (Scheduling Flow)

```mermaid
graph TD
    %% 오전 8시 종합 리포트
    subgraph DailyBatch ["오전 08:00 (일일 종합 리포트)"]
        Start8[오전 8:00 트리거] --> ReadDB[전일까지의 수집 및 병합 데이터 조회]
        ReadDB --> GenDaily[종합 리포트 생성 및 발행]
    end

    %% 매 1시간 주기 감시
    subgraph HourlyLoop ["매 1시간 주기 (단기 실시간 감시)"]
        StartHourly[매 1시간 트리거] --> CollectRealtime[실시간 주가 흐름 & 속보 뉴스 수집]
        CollectRealtime --> AnalyzeThesis[보유 이유 및 리스크 키워드 대조 분석]
        AnalyzeThesis --> Decision{"특이사항 / 위험 감지?"}
        
        Decision -->|Yes| SendNoti[단기 리포트 및 Noti 알림 발행]
        Decision -->|No| SkipNoti["알림 생략 (Silent)"]
    end

    %% 장 종료 후 배치
    subgraph MarketClose ["장 종료 후 (일괄 수집 및 데이터 정제)"]
        StartClose[장 종료 후 트리거] --> FetchAll[당일 데이터 전체 수집: DART, IR, KIND, NEWS, KRX]
        FetchAll --> MergeAll[1차 해시 중복 제거 & 2차 이벤트 병합 완료]
        MergeAll --> ReadyNextDay[다음날 오전 8시 발행용 데이터 준비 완료]
    end
    
    ReadyNextDay -.->|참조| ReadDB
```

---

## 3. 주간 운영 흐름 (Weekly Operations Flow)

```mermaid
graph TD
    W1[주말/주간 실행] --> W2[보유 종목별 이벤트 누적 추이 점검]
    W1 --> W3[ETF / 섹터별 흐름 점검]
    W1 --> W4[URL 레지스트리 오류 건 확인]
    
    W2 --> O1[리밸런싱 후보 및 포트폴리오 조정안 생성]
    W3 --> O1
    
    W4 --> O2{"접속 실패 URL 존재?"}
    O2 -->|Yes| O3[AI 모듈 호출: 공식 IR/뉴스룸 URL 탐색 및 갱신]
    O2 -->|No| O4[레지스트리 유지]
```
