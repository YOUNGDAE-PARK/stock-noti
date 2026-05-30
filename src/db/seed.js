import { getDb } from './db.js';

const initialAssets = [
  // Portfolio 1 (Original)
  {
    asset_type: 'stock',
    ticker: '009150',
    name: '삼성전기',
    market: 'KOSPI',
    holding_weight: 20.0,
    avg_price: 150000.0,
    holding_qty: 200.0,
    investment_thesis: 'AI 데이터센터 및 전장용 MLCC/FC-BGA 고부가 부품 공급 확대 수혜',
    risk_keywords: '스마트폰 수요 둔화, R&D 투자 감소, MLCC 단가 인하',
    watch_level: 'normal',
    is_active: 1
  },
  {
    asset_type: 'stock',
    ticker: '064400',
    name: 'LG CNS',
    market: 'KOSPI',
    holding_weight: 15.0,
    avg_price: 80000.0,
    holding_qty: 300.0,
    investment_thesis: 'AI 및 클라우드 DX 부문 성과 극대화, 그리고 해외 AI 스타트업(앤트로픽 등) 투자 가치 현실화',
    risk_keywords: 'R&D 투자 축소 우려, M&A 지연, SI 시장 경쟁 심화',
    watch_level: 'normal',
    is_active: 1
  },
  {
    asset_type: 'etf',
    ticker: '485620',
    name: 'TIGER 미국우주테크',
    market: 'ETF',
    holding_weight: 15.0,
    avg_price: 10000.0,
    holding_qty: 3000.0,
    investment_thesis: '글로벌 뉴스페이스 민간 주도 핵심 우주 기업 포트폴리오 편입 및 스페이스X 상장 시 최단기 편입 수혜',
    risk_keywords: '스페이스X 상장 연기, 미국 금리 고공행진, 뉴스페이스 고평가 논란, 괴리율 확대',
    watch_level: 'normal',
    is_active: 1
  },

  // Portfolio 2 (New Validation Assets)
  {
    asset_type: 'stock',
    ticker: '475960',
    name: '토모큐브',
    market: 'KOSDAQ',
    holding_weight: 10.0,
    avg_price: 55000.0,
    holding_qty: 500.0,
    investment_thesis: 'AI 기반 홀로토모그래피(HT) 장비 및 오가노이드/반도체 계측 신사업 확장',
    risk_keywords: '바이오 연구 예산 삭감, 신제품 HT-X1 출시 지연, 흑자 전환 지연',
    watch_level: 'normal',
    is_active: 1
  },
  {
    asset_type: 'stock',
    ticker: '064760',
    name: '티씨케이',
    market: 'KOSDAQ',
    holding_weight: 20.0,
    avg_price: 300000.0,
    holding_qty: 100.0,
    investment_thesis: '고순도 흑연 부품 및 Solid SiC 링의 독보적 지배력, 적극적인 주주 가치 제고(밸류업)',
    risk_keywords: '특허 만료 리스크, 반도체 공정 가동률 하락, 경쟁사 SiC 링 진입',
    watch_level: 'normal',
    is_active: 1
  },
  {
    asset_type: 'stock',
    ticker: '012330',
    name: '현대모비스',
    market: 'KOSPI',
    holding_weight: 20.0,
    avg_price: 430000.0,
    holding_qty: 150.0,
    investment_thesis: '전동화 사업 흑자 전환, 글로벌 완성차향 핵심 부품 수주 확대 및 미래 로보틱스/자율주행 R&D 성과',
    risk_keywords: '전기차 캐즘 장기화, 글로벌 자동차 수요 둔화, 완성차 단가 압박',
    watch_level: 'normal',
    is_active: 1
  }
];

async function seedDb() {
  console.log('Seeding portfolio assets...');
  const db = await getDb();

  // Clear previous assets first to keep it clean
  await db.run('DELETE FROM portfolio_asset');

  for (const asset of initialAssets) {
    try {
      await db.run(
        `INSERT INTO portfolio_asset (
          asset_type, ticker, name, market, holding_weight, avg_price, 
          holding_qty, investment_thesis, risk_keywords, watch_level, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          asset.asset_type,
          asset.ticker,
          asset.name,
          asset.market,
          asset.holding_weight,
          asset.avg_price,
          asset.holding_qty,
          asset.investment_thesis,
          asset.risk_keywords,
          asset.watch_level,
          asset.is_active
        ]
      );
      console.log(`- Seeded asset: ${asset.name} (${asset.ticker})`);
    } catch (err) {
      console.error(`- Error seeding ${asset.name}:`, err.message);
    }
  }

  console.log('Seeding completed.');
  process.exit(0);
}

seedDb().catch((err) => {
  console.error('Error seeding database:', err);
  process.exit(1);
});
