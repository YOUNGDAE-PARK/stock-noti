import axios from 'axios';
import dotenv from 'dotenv';
import { getDb } from '../../db/db.js';
import { calculateRawHash } from '../consolidator.js';

dotenv.config();

export async function collectDartDisclosures(startDateStr, endDateStr) {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ DART_API_KEY is missing. Skipping DART collection.');
    return [];
  }

  const db = await getDb();
  
  // Get active stock assets with corp_code
  const assets = await db.all(
    'SELECT ticker, name, corp_code FROM portfolio_asset WHERE asset_type = "stock" AND is_active = 1 AND corp_code IS NOT NULL'
  );

  if (assets.length === 0) {
    console.log('No stock assets with corp_codes found for DART collection.');
    return [];
  }

  // Format dates: YYYY-MM-DD -> YYYYMMDD
  const bgn_de = startDateStr.replace(/-/g, '');
  const end_de = endDateStr.replace(/-/g, '');

  console.log(`DART Collector: Fetching disclosures from ${bgn_de} to ${end_de}...`);
  const collectedItems = [];

  for (const asset of assets) {
    try {
      const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&corp_code=${asset.corp_code}&bgn_de=${bgn_de}&end_de=${end_de}&page_count=100`;
      
      const response = await axios.get(url);
      const data = response.data;

      if (data.status === '000') {
        const list = data.list || [];
        console.log(`- Found ${list.length} disclosures for ${asset.name} (${asset.ticker})`);
        
        for (const disclosure of list) {
          // Construct URL to view the report on DART
          const reportUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${disclosure.rcept_no}`;
          const publishedAt = `${disclosure.rcept_dt.substring(0, 4)}-${disclosure.rcept_dt.substring(4, 6)}-${disclosure.rcept_dt.substring(6, 8)} 09:00:00`; // DART lists date only, mock time as 09:00:00

          const rawItem = {
            source_type: 'DART',
            ticker: asset.ticker,
            title: `[공시] ${disclosure.report_nm}`,
            url: reportUrl,
            published_at: publishedAt,
            source_name: 'DART'
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
          } catch (dbErr) {
            if (!dbErr.message.includes('UNIQUE constraint failed')) {
              console.error(`Database insert error for DART item:`, dbErr.message);
            }
          }
        }
      } else if (data.status === '013') {
        // No data found is status '013', not an error
        console.log(`- No disclosures found for ${asset.name} (${asset.ticker})`);
      } else {
        console.error(`- DART API returned error status ${data.status} for ${asset.name}: ${data.message}`);
      }
    } catch (err) {
      console.error(`- Failed to fetch disclosures for ${asset.name} (${asset.ticker}):`, err.message);
    }
  }

  return collectedItems;
}
