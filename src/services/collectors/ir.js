import axios from 'axios';
import { getDb } from '../../db/db.js';
import { calculateRawHash } from '../consolidator.js';

export async function collectIrNewsroomData() {
  const db = await getDb();

  // Get active registries
  const registries = await db.all(
    'SELECT * FROM source_registry WHERE status = "active"'
  );

  if (registries.length === 0) {
    console.log('No active IR/Newsroom registries to collect from.');
    return [];
  }

  console.log(`IR Collector: Fetching from ${registries.length} registered sites...`);
  const collectedItems = [];

  for (const reg of registries) {
    try {
      const urlToFetch = reg.rss_url || reg.source_url;
      if (!urlToFetch) continue;

      console.log(`- Scanning ${reg.source_type} for ticker ${reg.ticker} at: ${urlToFetch}`);
      
      const response = await axios.get(urlToFetch, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9'
        },
        timeout: 5000
      });

      const html = response.data;

      // Extract raw titles and links depending on RSS or HTML list
      const extractedLinks = [];

      if (reg.rss_url || urlToFetch.includes('rss') || urlToFetch.includes('xml')) {
        // Parse simple RSS XML items
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(html)) !== null) {
          const block = match[1];
          const titleM = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/.exec(block);
          const linkM = /<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>|<link>([\s\S]*?)<\/link>/.exec(block);
          
          if (titleM && linkM) {
            extractedLinks.push({
              title: (titleM[1] || titleM[2]).trim(),
              url: (linkM[1] || linkM[2]).trim()
            });
          }
        }
      } else {
        // Parse simple HTML anchor links <a> containing key news titles
        // We look for links with title-like attributes or containing Korean texts
        const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = anchorRegex.exec(html)) !== null) {
          const href = match[1].trim();
          const text = match[2].replace(/<[^>]*>/g, '').trim();

          // Simple heuristic: news items in IR pages usually have text longer than 10 chars, and contain Korean
          if (text.length > 10 && /[가-힣]/.test(text) && !href.startsWith('#') && !href.startsWith('javascript:')) {
            // Normalize relative URLs
            let absoluteUrl = href;
            if (href.startsWith('/')) {
              absoluteUrl = `${reg.domain || ''}${href}`;
            } else if (!href.startsWith('http')) {
              absoluteUrl = `${reg.source_url}/${href}`;
            }

            extractedLinks.push({
              title: text,
              url: absoluteUrl
            });
          }
        }
      }

      console.log(`  -> Found ${extractedLinks.length} candidate links.`);

      let addedCount = 0;
      // We only store the top 5 latest candidate items to avoid history bloating
      const topCandidates = extractedLinks.slice(0, 5);

      for (const candidate of topCandidates) {
        const rawItem = {
          source_type: 'IR',
          ticker: reg.ticker,
          title: `[공식 발표] ${candidate.title}`,
          url: candidate.url,
          published_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
          source_name: reg.source_type
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
          addedCount++;
          collectedItems.push(rawItem);
        } catch (dbErr) {
          if (!dbErr.message.includes('UNIQUE constraint failed')) {
            console.error(`Database insert error for IR newsroom item:`, dbErr.message);
          }
        }
      }

      // Reset fail count if successful
      if (reg.fail_count > 0) {
        await db.run(
          'UPDATE source_registry SET fail_count = 0, verified_at = CURRENT_TIMESTAMP WHERE source_id = ?',
          [reg.source_id]
        );
      }
      console.log(`  -> Saved ${addedCount} new announcements.`);

    } catch (err) {
      console.error(`- Failed to scan registry for ${reg.ticker}:`, err.message);
      
      // Increment fail count
      const newFailCount = (reg.fail_count || 0) + 1;
      let newStatus = reg.status;
      if (newFailCount >= 3) {
        newStatus = 'needs_review';
        console.warn(`⚠️ Registry for ${reg.ticker} marked as needs_review due to 3 consecutive failures.`);
      }

      await db.run(
        'UPDATE source_registry SET fail_count = ?, status = ? WHERE source_id = ?',
        [newFailCount, newStatus, reg.source_id]
      );
    }
  }

  return collectedItems;
}
