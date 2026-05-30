import axios from 'axios';
import { getDb } from '../../db/db.js';
import { calculateRawHash } from '../consolidator.js';

export async function collectKindRiskDisclosures() {
  const db = await getDb();
  
  // Get active assets
  const assets = await db.all(
    'SELECT ticker, name FROM portfolio_asset WHERE is_active = 1'
  );

  if (assets.length === 0) {
    return [];
  }

  console.log('KIND Collector: Checking KIND Today RSS for risk warnings...');
  const collectedItems = [];

  try {
    // Fetch KIND Today's Disclosures RSS
    const url = 'https://kind.krx.co.kr/disclosure/todaydisclosure.do?method=searchTodayDisclosureRSS';
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const xmlContent = response.data;

    // Parse RSS items using Regex to avoid heavy XML parser dependencies
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(xmlContent)) !== null) {
      const block = itemMatch[1];
      
      const titleMatch = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/.exec(block);
      const linkMatch = /<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>|<link>([\s\S]*?)<\/link>/.exec(block);
      const pubDateMatch = /<pubDate><!\[CDATA\[([\s\S]*?)\]\]><\/pubDate>|<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);

      const title = titleMatch ? (titleMatch[1] || titleMatch[2]).trim() : '';
      const link = linkMatch ? (linkMatch[1] || linkMatch[2]).trim() : '';
      const pubDate = pubDateMatch ? (pubDateMatch[1] || pubDateMatch[2]).trim() : '';

      // Check if this disclosure is related to any of our portfolio assets
      const matchedAsset = assets.find(asset => title.includes(asset.name));

      if (matchedAsset) {
        // Look for risk keywords in the disclosure title
        const isRiskDisclosure = 
          title.includes('거래정지') || 
          title.includes('관리종목') || 
          title.includes('불성실공시') || 
          title.includes('투자주의') || 
          title.includes('투자경고') || 
          title.includes('투자위험') ||
          title.includes('시장경보') ||
          title.includes('상장폐지') ||
          title.includes('상장적격성');

        if (isRiskDisclosure) {
          let publishedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
          try {
            if (pubDate) {
              const parsedDate = new Date(pubDate);
              if (!isNaN(parsedDate)) {
                publishedAt = parsedDate.toISOString().replace('T', ' ').substring(0, 19);
              }
            }
          } catch (e) {
            // fallback
          }

          const rawItem = {
            source_type: 'KIND',
            ticker: matchedAsset.ticker,
            title: `[KIND] ${title}`,
            url: link,
            published_at: publishedAt,
            source_name: 'KIND 공시'
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
            console.log(`- Detected KIND risk alert for ${matchedAsset.name}: ${title}`);
            collectedItems.push(rawItem);
          } catch (dbErr) {
            if (!dbErr.message.includes('UNIQUE constraint failed')) {
              console.error(`Database insert error for KIND item:`, dbErr.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('KIND Collector failed to fetch RSS:', err.message);
  }

  return collectedItems;
}
