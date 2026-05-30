import axios from 'axios';
import dotenv from 'dotenv';
import { getDb } from '../../db/db.js';
import { calculateRawHash } from '../consolidator.js';

dotenv.config();

// Keywords that indicate noise/spam news that we want to ignore
const NOISE_KEYWORDS = [
  '테마주', '급등주', '관련주', '특징주', '상승세', '하락세', '시황', 
  '마감', '상승 출발', '하락 출발', '증시요약', '코스피', '코스닥'
];

export async function collectNaverNews() {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('⚠️ Naver News API keys are missing. Skipping Naver News collection.');
    return [];
  }

  const db = await getDb();
  
  // Get active assets
  const assets = await db.all(
    'SELECT ticker, name, investment_thesis, risk_keywords FROM portfolio_asset WHERE is_active = 1'
  );

  if (assets.length === 0) {
    console.log('No active assets found for Naver News collection.');
    return [];
  }

  console.log(`Naver News Collector: Fetching news for ${assets.length} assets...`);
  const collectedItems = [];

  for (const asset of assets) {
    try {
      // Query Naver News search API for the asset name
      const query = encodeURIComponent(asset.name);
      const url = `https://openapi.naver.com/v1/search/news.json?query=${query}&display=30&sort=date`;

      const response = await axios.get(url, {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret
        }
      });

      const items = response.data.items || [];
      console.log(`- Fetched ${items.length} raw articles for ${asset.name}`);

      // Parse and filter articles
      const thesisTerms = (asset.investment_thesis || '').toLowerCase();
      const riskKeywords = (asset.risk_keywords || '')
        .toLowerCase()
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);

      let addedForAsset = 0;

      for (const item of items) {
        const titleClean = item.title.replace(/<[^>]*>/g, ''); // strip HTML tags like <b>
        const descClean = item.description.replace(/<[^>]*>/g, '');
        const titleLower = titleClean.toLowerCase();
        const descLower = descClean.toLowerCase();

        // 1. Noise Filter: Ignore typical ticker-related clickbait/market recap articles
        const isNoise = NOISE_KEYWORDS.some(noise => titleLower.includes(noise));
        if (isNoise) continue;

        // 2. Thesis & Risk Match Filter:
        // Check if article title or description contains any of the risk keywords, OR key thesis terms
        const matchesRisk = riskKeywords.some(keyword => titleLower.includes(keyword) || descLower.includes(keyword));
        const matchesThesis = (
          thesisTerms.includes('반도체') && (titleLower.includes('반도체') || titleLower.includes('hbm') || titleLower.includes('d램') || titleLower.includes('dram')) ||
          thesisTerms.includes('지수') && (titleLower.includes('s&p') || titleLower.includes('나스닥') || titleLower.includes('금리') || titleLower.includes('연준')) ||
          riskKeywords.some(keyword => thesisTerms.includes(keyword)) // fallback
        );

        // Keep it if it matches a risk keyword or strongly aligns with the investment thesis
        if (matchesRisk || matchesThesis || riskKeywords.length === 0) {
          // Parse Naver News date: "Sat, 30 May 2026 12:00:00 +0900" -> YYYY-MM-DD HH:mm:ss
          let publishedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
          try {
            if (item.pubDate) {
              const pubDateParsed = new Date(item.pubDate);
              if (!isNaN(pubDateParsed)) {
                publishedAt = pubDateParsed.toISOString().replace('T', ' ').substring(0, 19);
              }
            }
          } catch (dateErr) {
            // fallback to current time
          }

          const rawItem = {
            source_type: 'NEWS',
            ticker: asset.ticker,
            title: titleClean,
            url: item.link,
            published_at: publishedAt,
            source_name: '네이버뉴스'
          };

          const rawHash = calculateRawHash(rawItem);

          try {
            await db.run(
              `INSERT INTO raw_source_item (
                source_type, ticker, title, url, published_at, source_name, raw_hash, status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
              [
                rawItem.source_type,
                rawItem.ticker,
                rawItem.title,
                rawItem.url,
                rawItem.published_at,
                rawItem.source_name,
                rawHash
              ]
            );
            collectedItems.push(rawItem);
            addedForAsset++;
          } catch (dbErr) {
            if (!dbErr.message.includes('UNIQUE constraint failed')) {
              console.error(`Database insert error for Naver news item:`, dbErr.message);
            }
          }
        }
      }

      console.log(`  -> Filtered and saved ${addedForAsset} relevant articles for ${asset.name}`);
    } catch (err) {
      console.error(`- Failed to fetch news for ${asset.name} (${asset.ticker}):`, err.message);
    }
  }

  return collectedItems;
}
