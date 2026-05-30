import crypto from 'crypto';
import { getDb } from '../db/db.js';

// Calculate unique hash for 1st level deduplication
export function calculateRawHash(item) {
  const normalizedTitle = (item.title || '')
    .toLowerCase()
    .replace(/[^a-zA-Z0-9가-힣\s]/g, '') // remove special chars
    .trim();
  const dateStr = item.published_at ? item.published_at.substring(0, 10) : '';
  const inputStr = `${item.source_type}|${item.url}|${normalizedTitle}|${dateStr}`;
  return crypto.createHash('md5').update(inputStr).digest('hex');
}

// Tokenize and clean titles
function getCleanTokens(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-zA-Z0-9가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 1) // exclude single chars
  );
}

// Simple token similarity check for 2nd level deduplication
export function calculateTitleSimilarity(title1, title2) {
  const tokens1 = getCleanTokens(title1);
  const tokens2 = getCleanTokens(title2);

  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  const intersection = new Set([...tokens1].filter(t => tokens2.has(t)));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.size / union.size;
}

// Classify event type based on title keywords
export function classifyEventType(title, source_type) {
  const text = title.toLowerCase();
  
  if (source_type === 'DART') {
    if (text.includes('공급계약') || text.includes('단일판매')) return '수주 / 공급계약';
    if (text.includes('유상증자')) return '유상증자';
    if (text.includes('전환사채') || text.includes('신주인수권')) return 'CB / BW';
    if (text.includes('배당') || text.includes('주주환원')) return '자사주 / 배당';
    if (text.includes('분기보고서') || text.includes('반기보고서') || text.includes('사업보고서') || text.includes('실적')) return '실적';
    if (text.includes('최대주주')) return '최대주주 변경';
    if (text.includes('정정')) return '정정공시';
  }

  // General text checks for news/IR
  if (text.includes('수주') || text.includes('계약') || text.includes('공급')) return '수주 / 공급계약';
  if (text.includes('실적') || text.includes('매출') || text.includes('영업이익') || text.includes('어닝')) {
    if (text.includes('쇼크') || text.includes('하락') || text.includes('적자')) return '어닝쇼크';
    if (text.includes('호조') || text.includes('최대') || text.includes('서프라이즈') || text.includes('상승')) return '실적 호조';
    return '실적';
  }
  if (text.includes('증설') || text.includes('설비투자') || text.includes('capex')) return '증설 / CAPEX';
  if (text.includes('유상증자')) return '유상증자';
  if (text.includes('전환사채') || text.includes('cb') || text.includes('bw')) return 'CB / BW';
  if (text.includes('배당') || text.includes('자사주')) return '자사주 / 배당';
  if (text.includes('리콜') || text.includes('품질') || text.includes('불량')) return '리콜 / 품질 문제';
  if (text.includes('소송') || text.includes('과징금') || text.includes('규제') || text.includes('제재') || text.includes('통제')) return '소송 / 규제 / 과징금';
  if (text.includes('금리') || text.includes('연준') || text.includes('fomc')) return '금리 / 매크로';
  
  return '일반동향';
}

// Get reliability score based on source type
export function getReliabilityScore(source_type) {
  const scores = {
    'DART': 5,
    'IR': 4,
    'KIND': 3,
    'NEWS': 2
  };
  return scores[source_type] || 1;
}

// Get source priority ranking (lower is higher priority)
export function getSourcePriorityRank(source_type) {
  const ranks = {
    'DART': 1,
    'IR': 2,
    'KIND': 3,
    'NEWS': 4
  };
  return ranks[source_type] || 5;
}

// List of high-value keywords that strongly indicate matching topics
const HIGH_VALUE_KEYWORDS = [
  'hbm', 'hbm3e', '엔비디아', 'd램', '낸드', '금리', '연준', 
  '수출통제', '수출 통제', '수출 규제', '공급계약', '수주', '실적'
];

function shareHighValueKeyword(title1, title2) {
  const t1 = title1.toLowerCase();
  const t2 = title2.toLowerCase();
  
  return HIGH_VALUE_KEYWORDS.some(keyword => 
    t1.includes(keyword) && t2.includes(keyword)
  );
}

// Consolidate new raw source items into investment events
export async function consolidateEvents() {
  const db = await getDb();
  
  const newItems = await db.all(
    'SELECT * FROM raw_source_item WHERE status = "new" ORDER BY published_at ASC'
  );

  console.log(`Consolidator found ${newItems.length} new raw items to process.`);

  for (const item of newItems) {
    const eventType = classifyEventType(item.title, item.source_type);
    const itemDate = item.published_at ? item.published_at.substring(0, 10) : new Date().toISOString().substring(0, 10);
    const newSourceRank = getSourcePriorityRank(item.source_type);
    
    // Query ALL events of the same ticker within +/- 3 days, regardless of event_type
    const existingEvents = await db.all(
      `SELECT * FROM investment_event 
       WHERE ticker = ? 
       AND abs(strftime('%J', event_date) - strftime('%J', ?)) <= 3`,
      [item.ticker, itemDate]
    );

    let targetEvent = null;

    // Compare with existing events to find a match
    for (const event of existingEvents) {
      const similarity = calculateTitleSimilarity(item.title, event.event_title);
      const sharesKeyword = shareHighValueKeyword(item.title, event.event_title);

      // Match conditions:
      // 1. Same event_type AND similarity > 0.15
      // 2. OR they share a high-value keyword AND similarity > 0.08
      if ((eventType === event.event_type && similarity > 0.15) || (sharesKeyword && similarity > 0.08)) {
        targetEvent = event;
        break;
      }
    }

    if (targetEvent) {
      // Merge into existing event
      console.log(`- Merging raw item "${item.title}" into existing event [ID: ${targetEvent.event_id}] "${targetEvent.event_title}"`);
      
      const currentPrimaryRank = getSourcePriorityRank(targetEvent.primary_source_type);

      // Link in mapping table
      await db.run(
        `INSERT OR IGNORE INTO event_source_link (event_id, raw_id, is_primary, source_rank) 
         VALUES (?, ?, ?, ?)`,
        [targetEvent.event_id, item.raw_id, 0, newSourceRank]
      );

      // Select more specific event_type if they were different
      // e.g. Upgrade from '일반동향' to a specific type
      let updatedEventType = targetEvent.event_type;
      if (targetEvent.event_type === '일반동향' && eventType !== '일반동향') {
        updatedEventType = eventType;
      }

      // If new source has higher priority, make it primary
      if (newSourceRank < currentPrimaryRank) {
        console.log(`  -> Upgrading primary source to ${item.source_type}: ${item.url}`);
        
        await db.run(
          'UPDATE event_source_link SET is_primary = 0 WHERE event_id = ? AND is_primary = 1',
          [targetEvent.event_id]
        );
        
        await db.run(
          'UPDATE event_source_link SET is_primary = 1 WHERE event_id = ? AND raw_id = ?',
          [targetEvent.event_id, item.raw_id]
        );

        await db.run(
          `UPDATE investment_event 
           SET event_type = ?, primary_source_type = ?, primary_source_url = ?, 
               source_count = source_count + 1, reliability_score = max(reliability_score, ?)
           WHERE event_id = ?`,
          [updatedEventType, item.source_type, item.url, getReliabilityScore(item.source_type), targetEvent.event_id]
        );
      } else {
        await db.run(
          `UPDATE investment_event 
           SET event_type = ?, source_count = source_count + 1 
           WHERE event_id = ?`,
          [updatedEventType, targetEvent.event_id]
        );
      }

      await db.run(
        'UPDATE raw_source_item SET status = "merged" WHERE raw_id = ?',
        [item.raw_id]
      );

    } else {
      // Create new event
      console.log(`- Creating new event for raw item "${item.title}"`);
      
      const reliability = getReliabilityScore(item.source_type);
      const asset = await db.get('SELECT asset_id FROM portfolio_asset WHERE ticker = ?', [item.ticker]);
      const assetId = asset ? asset.asset_id : null;

      const result = await db.run(
        `INSERT INTO investment_event (
          asset_id, ticker, event_type, event_title, event_date, 
          primary_source_type, primary_source_url, source_count, reliability_score, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assetId,
          item.ticker,
          eventType,
          item.title,
          itemDate,
          item.source_type,
          item.url,
          1,
          reliability,
          'needs_review'
        ]
      );

      const newEventId = result.lastID;

      await db.run(
        `INSERT INTO event_source_link (event_id, raw_id, is_primary, source_rank) 
         VALUES (?, ?, ?, ?)`,
        [newEventId, item.raw_id, 1, newSourceRank]
      );

      await db.run(
        'UPDATE raw_source_item SET status = "merged" WHERE raw_id = ?',
        [item.raw_id]
      );
    }
  }

  console.log('Event consolidation completed.');
}
