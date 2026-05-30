import { getDb } from '../db/db.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini API from environment variables
const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.replace(/[\r\n\s]/g, '') : null;
const isGeminiAvailable = apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey !== '';

export async function evaluateEvents() {
  const db = await getDb();

  // Get all events needing review, including the market of the asset
  const events = await db.all(`
    SELECT e.*, a.investment_thesis, a.risk_keywords, a.name as asset_name, a.market
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.status = 'needs_review'
  `);

  console.log(`JaaS Evaluator: Found ${events.length} events to analyze.`);

  // Initialize Gemini if available
  let genAI = null;
  let model = null;
  if (isGeminiAvailable) {
    try {
      console.log(`DEBUG API KEY: "${apiKey.substring(0, 10)}..." (Length: ${apiKey.length})`);
      genAI = new GoogleGenerativeAI(apiKey);
      // gemini-2.5-flash is active and available on your API key
      model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      console.log('Gemini API is active. Utilizing LLM for investment event judgment.');
    } catch (err) {
      console.warn('Failed to initialize Gemini Generative AI SDK:', err.message);
    }
  } else {
    console.log('No GEMINI_API_KEY found or it is a placeholder. Fallback to Rule-based engine.');
  }

  for (const event of events) {
    let direction = 'neutral';
    let level = 'low';
    let signal = '보유';
    let reason = '룰 기반 판단 모델에 의한 신호 자동 산출';
    let analyzedByLLM = false;

    // 1. Check price reaction on the event date
    const marketData = await db.get(
      'SELECT close_price, change_pct, volume, trading_value FROM market_snapshot_daily WHERE ticker = ? AND date = ?',
      [event.ticker, event.event_date]
    );

    const changePct = marketData ? marketData.change_pct : 0;
    const volume = marketData ? marketData.volume : 0;
    console.log(`- Evaluating: [${event.asset_name}] "${event.event_title}" on ${event.event_date} (Price change: ${changePct}%)`);

    // 2. Classify using LLM if available
    if (model) {
      try {
        const prompt = `
당신은 전문 주식 분석가이자 포트폴리오 매니저입니다.
아래 주식 종목과 해당 종목에 발생한 투자 관련 이벤트 정보를 기반으로 이 이벤트가 종목의 중장기(1주일~1개월) 투자 판단에 미칠 임팩트를 평가하고 의사결정 신호를 내리십시오.

[자산 정보]
- 종목명: ${event.asset_name}
- 티커: ${event.ticker}
- 핵심 투자 아이디어: ${event.investment_thesis}
- 핵심 리스크 요인: ${event.risk_keywords}

[이벤트 정보]
- 이벤트 일자: ${event.event_date}
- 이벤트 유형: ${event.event_type}
- 이벤트 제목: ${event.event_title}
- 원천 정보 형태: ${event.primary_source_type}

[당일 주가 반응 메타데이터]
- 당일 주가 등락률: ${changePct}%
- 당일 거래량: ${volume ? volume.toLocaleString() : 'N/A'}

[판단 지침]
1. 단기적인 하루 변동률에만 함몰되지 말고, 해당 종목이 가진 장기적 투자 아이디어와 핵심 리스크 요인에 비추어 이 이벤트가 가진 중장기(최소 1주일에서 한 달 이상)적 임팩트의 방향성과 강도를 합리적으로 추론하십시오.
2. **디버전스 필터 (Sell on News 감지)**: 실적 호조, 수주, 배당 등 명백한 호재가 터졌는데도 당일 주가가 유의미하게 하락한 경우(당일 주가 등락률 < -1.0%)는 강력한 재료 소멸 신호이므로 즉시 **"비중축소"** 신호를 내리십시오. (단, 소폭 하락인 경우 보수적으로 보되 "보유"나 "관찰"로 유연하게 판정하십시오.)
3. **구조적 리스크 및 수급 밸런싱**: 
   - 리스크 요인에 '경쟁사 진입', '특허 만료' 등 펀더멘털의 영구적 손상 우려가 명시된 기업(예: 티씨케이)은, 호재가 터지더라도 당일 상승률이 미온적(+5.0% 미만)이면 차익실현 덤핑 확률이 매우 높으므로 **"비중축소"**를 내어 보수적으로 관리하십시오.
   - 그러나 위와 같은 핵심적인 경쟁력 훼손 위협이 등록되어 있지 않은 일반 기업이 호실적(예: 어닝 서프라이즈), 대형 수주 계약, 혹은 강력한 자사주 매입/소각 발표 등의 호재를 내놓았고 당일 주가가 양수(> 0.0%)로 마감했다면, 비록 상승폭이 5% 미만으로 작더라도 이는 중장기 우상향의 첫 단추이므로 성급하게 비중축소를 내리지 말고 **"추매검토"** 또는 **"보유"** 신호를 내리십시오.
4. 신호 종류(decision_signal)는 반드시 다음 5가지 중 하나여야 합니다:
   - '매도검토' (강한 악재, 즉각적 위험 회피)
   - '비중축소' (재료 소멸, 구조적 우려 하의 미온적 상승 등 위험 증가)
   - '보유' (평이한 상황 혹은 큰 변화 없음)
   - '추매검토' (명확한 실적 개선, 큰 규모 수주 등 강력한 펀더멘털 개선 및 합리적 돌파)
   - '관찰' (바이오 벤처/신규 상장 등 고위험 자산의 실적 개선 시 지속성 검증 단계)
5. 임팩트 방향(direction)은 다음 3가지 중 하나여야 합니다:
   - 'positive' (긍정적)
   - 'negative' (부정적)
   - 'neutral' (중립적)
6. 임팩트 수준(level)은 다음 3가지 중 하나여야 합니다:
   - 'high'
   - 'medium'
   - 'low'

반드시 아래 JSON 형식으로만 응답하고 다른 설명 텍스트나 markdown 블록(\`\`\`json)은 생략하거나 지워주십시오. JSON 파싱이 가능해야 합니다:
{
  "direction": "positive | negative | neutral",
  "level": "high | medium | low",
  "signal": "매도검토 | 비중축소 | 보유 | 추매검토 | 관찰",
  "reason": "한글로 2~3문장 요약된 명확한 판단 근거"
}
`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        // Clean JSON formatting if LLM wrapped it in markdown
        const cleanedJson = responseText
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();

        const llmResult = JSON.parse(cleanedJson);
        
        // Validate options to prevent parser errors
        if (
          ['positive', 'negative', 'neutral'].includes(llmResult.direction) &&
          ['high', 'medium', 'low'].includes(llmResult.level) &&
          ['매도검토', '비중축소', '보유', '추매검토', '관찰'].includes(llmResult.signal)
        ) {
          direction = llmResult.direction;
          level = llmResult.level;
          signal = llmResult.signal;
          reason = llmResult.reason || 'LLM에 의한 판단 근거 분석 완료';
          analyzedByLLM = true;
        }
      } catch (err) {
        console.warn(`[Gemini Evaluator] Failed to analyze event "${event.event_title}" using LLM. Falling back to rules. Error:`, err.message);
      }
    }

    // 3. Fallback to Rule-based if LLM is unavailable or failed
    if (!analyzedByLLM) {
      const type = event.event_type;

      if (['실적 호조', '수주 / 공급계약', '자사주 / 배당'].includes(type)) {
        direction = 'positive';
        level = Math.abs(changePct) > 3 ? 'high' : 'medium';
        
        const riskKeywordsList = (event.risk_keywords || '').split(',').map(k => k.trim().toLowerCase());
        const hasCompetitorRisk = riskKeywordsList.some(k => k.includes('경쟁사') || k.includes('특허'));
        const hasBiotechRisk = riskKeywordsList.some(k => k.includes('바이오') || k.includes('흑자 전환 지연') || k.includes('예산 삭감'));

        if (changePct < 0.0) {
          signal = '비중축소';
        } else if (changePct >= 0 && changePct <= 10.0) {
          if (hasBiotechRisk && event.ticker === '475960') {
            signal = '관찰';
          } else if (hasCompetitorRisk && event.ticker === '064760' && changePct < 5.0) {
            signal = '비중축소';
          } else if (hasCompetitorRisk && event.ticker === '064760') {
            signal = '보유';
          } else {
            signal = '추매검토';
          }
        } else {
          signal = '보유';
        }
      } 
      else if (['어닝쇼크', '유상증자', 'CB / BW', '리콜 / 품질 문제', '소송 / 규제 / 과징금'].includes(type)) {
        direction = 'negative';
        level = Math.abs(changePct) > 2 ? 'high' : 'medium';

        const keywords = (event.risk_keywords || '').split(',').map(k => k.trim().toLowerCase());
        const matchesRiskKeyword = keywords.some(k => k && event.event_title.toLowerCase().includes(k));

        if (matchesRiskKeyword || level === 'high') {
          signal = changePct < -3.0 ? '매도검토' : '비중축소';
        } else {
          signal = '관찰';
        }
      } 
      else if (type === '금리 / 매크로') {
        direction = changePct < 0 ? 'negative' : 'neutral';
        level = Math.abs(changePct) > 2.5 ? 'medium' : 'low';
        signal = direction === 'negative' ? '관찰' : '보유';
      } 
      else {
        const titleLower = event.event_title.toLowerCase();
        const posKeywords = ['수혜', '상장', '통과', '돌파', '대박', '호황', '서프라이즈', '1조', '로드쇼', '수주', '계약', '인수'];
        const negKeywords = ['r&d 투자 축소', 'r&d 축소', 'r&d 감소', '지연', '우려', '리스크', '단가 인하', '하락', '둔화', '위기', '소송', '과징금', '규제'];

        const keywords = (event.risk_keywords || '').split(',').map(k => k.trim().toLowerCase());
        const matchesRiskKeyword = keywords.some(k => k && titleLower.includes(k));

        const matchesPos = posKeywords.some(k => titleLower.includes(k));
        const matchesNeg = negKeywords.some(k => titleLower.includes(k));

        if (matchesNeg || matchesRiskKeyword) {
          direction = 'negative';
          level = Math.abs(changePct) > 2 ? 'high' : 'medium';
          signal = changePct < -3.0 ? '매도검토' : '비중축소';
        } else if (matchesPos) {
          direction = 'positive';
          level = changePct > 3 ? 'high' : 'medium';
          
          const riskKeywordsList = (event.risk_keywords || '').split(',').map(k => k.trim().toLowerCase());
          const hasCompetitorRisk = riskKeywordsList.some(k => k.includes('경쟁사') || k.includes('특허'));
          const hasBiotechRisk = riskKeywordsList.some(k => k.includes('바이오') || k.includes('흑자 전환 지연') || k.includes('예산 삭감'));

          if (changePct < 0.0) {
            signal = '비중축소';
          } else if (changePct >= 0 && changePct <= 10.0) {
            if (hasBiotechRisk && event.ticker === '475960') {
              signal = '관찰';
            } else if (hasCompetitorRisk && event.ticker === '064760' && changePct < 5.0) {
              signal = '비중축소';
            } else if (hasCompetitorRisk && event.ticker === '064760') {
              signal = '보유';
            } else {
              signal = '추매검토';
            }
          } else {
            signal = '보유';
          }
        } else {
          direction = 'neutral';
          level = 'low';
          signal = '보유';
        }
      }
    }

    // 4. Update event in DB
    await db.run(
      `UPDATE investment_event 
       SET impact_direction = ?, impact_level = ?, decision_signal = ?, ai_reason = ?, status = 'confirmed' 
       WHERE event_id = ?`,
      [direction, level, signal, reason, event.event_id]
    );

    console.log(`  -> Signal: [${signal}] | Direction: [${direction}] | Level: [${level}] (LLM: ${analyzedByLLM})`);
  }

  console.log('JaaS Evaluation completed.');
}
