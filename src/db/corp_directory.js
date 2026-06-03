import fs from 'fs';
import path from 'path';
import axios from 'axios';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';
import { getDb } from './db.js';

dotenv.config();

const DART_API_KEY = process.env.DART_API_KEY ? process.env.DART_API_KEY.replace(/[\r\n\s]/g, '') : null;
const TEMP_DIR = './data/temp';
const ZIP_PATH = path.join(TEMP_DIR, 'corp_codes_search.zip');
const XML_PATH = path.join(TEMP_DIR, 'CORPCODE.xml');

// Fallback search directory containing major Korean stocks and ETFs
const fallbackDirectory = [
  { ticker: '005930', corp_name: '삼성전자', corp_code: '00126380' },
  { ticker: '000660', corp_name: 'SK하이닉스', corp_code: '00164779' },
  { ticker: '035420', corp_name: 'NAVER', corp_code: '00266961' },
  { ticker: '035720', corp_name: '카카오', corp_code: '00258838' },
  { ticker: '005380', corp_name: '현대자동차', corp_code: '00164742' },
  { ticker: '000270', corp_name: '기아', corp_code: '00236100' },
  { ticker: '051910', corp_name: 'LG화학', corp_code: '00366997' },
  { ticker: '009150', corp_name: '삼성전기', corp_code: '00137599' },
  { ticker: '064400', corp_name: 'LG CNS', corp_code: '00257323' },
  { ticker: '475960', corp_name: '토모큐브', corp_code: '01717326' },
  { ticker: '064760', corp_name: '티씨케이', corp_code: '00378035' },
  { ticker: '012330', corp_name: '현대모비스', corp_code: '00138941' },
  { ticker: '207940', corp_name: '삼성바이오로직스', corp_code: '00877080' },
  { ticker: '068270', corp_name: '셀트리온', corp_code: '00350321' },
  { ticker: '005490', corp_name: 'POSCO홀딩스', corp_code: '00123684' },
  { ticker: '036570', corp_name: '엔씨소프트', corp_code: '00250669' },
  { ticker: '035250', corp_name: '강원랜드', corp_code: '00259837' },
  { ticker: '485620', corp_name: 'TIGER 미국우주테크 (ETF)', corp_code: 'etf_485620' },
  { ticker: '379180', corp_name: 'TIGER 미국필라델피아반도체나스닥 (ETF)', corp_code: 'etf_379180' },
  { ticker: '133690', corp_name: 'TIGER 미국나스닥100 (ETF)', corp_code: 'etf_133690' },
  { ticker: '453950', corp_name: 'KODEX 미국S&P500 (ETF)', corp_code: 'etf_453950' },
  { ticker: '069500', corp_name: 'KODEX 200 (ETF)', corp_code: 'etf_069500' },
  { ticker: '445290', corp_name: 'KODEX 로봇액티브 (ETF)', corp_code: 'etf_445290' },
  { ticker: '0167A0', corp_name: 'SOL AI반도체TOP2플러스 (ETF)', corp_code: 'etf_0167A0' },
  { ticker: '469150', corp_name: 'ACE AI반도체TOP3+ (ETF)', corp_code: 'etf_469150' },
  { ticker: '0194T0', corp_name: 'ACE SK하이닉스단일종목레버리지 (ETF)', corp_code: 'etf_0194T0' }
];

export async function buildCorpDirectory(force = false) {
  const db = await getDb();

  // 1. Ensure directory table exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS corp_code_directory (
      ticker TEXT PRIMARY KEY,
      corp_name TEXT NOT NULL,
      corp_code TEXT NOT NULL
    )
  `);

  // 2. Always ensure fallback items (ETFs etc) are present
  console.log('[Corp Directory] Merging fallback assets...');
  for (const item of fallbackDirectory) {
    await db.run(
      'INSERT OR REPLACE INTO corp_code_directory (ticker, corp_name, corp_code) VALUES (?, ?, ?)',
      [item.ticker, item.corp_name, item.corp_code]
    );
  }

  // 3. Check if we need full DART download
  const countRes = await db.get('SELECT COUNT(*) as count FROM corp_code_directory');
  if (countRes.count > fallbackDirectory.length && !force) {
    console.log(`[Corp Directory] Already populated with ${countRes.count} tickers. Skipping DART sync.`);
    return;
  }

  console.log('[Corp Directory] Initializing search directory...');

  if (!DART_API_KEY || DART_API_KEY === 'your_dart_api_key_here') {
    console.warn('⚠️ DART_API_KEY is not defined. Initializing search directory with fallback major stock & ETF lists.');
    await seedFallbackDirectory(db);
    return;
  }

  // Ensure temp directory exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  try {
    console.log('Downloading complete corp_code zip from OpenDART API for search dictionary...');
    const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_API_KEY}`;
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'arraybuffer',
      timeout: 30000 // 30s timeout
    });

    fs.writeFileSync(ZIP_PATH, response.data);

    console.log('Extracting ZIP...');
    const zip = new AdmZip(ZIP_PATH);
    zip.extractAllTo(TEMP_DIR, true);

    if (!fs.existsSync(XML_PATH)) {
      throw new Error('Failed to find CORPCODE.xml inside OpenDART zip.');
    }

    console.log('Parsing CORPCODE.xml for all listed companies...');
    const xmlContent = fs.readFileSync(XML_PATH, 'utf-8');

    // Parse all XML list blocks
    const listRegex = /<list>([\s\S]*?)<\/list>/g;
    const corpCodeRegex = /<corp_code>(.*?)<\/corp_code>/;
    const corpNameRegex = /<corp_name>(.*?)<\/corp_name>/;
    const stockCodeRegex = /<stock_code>(.*?)<\/stock_code>/;

    const listToInsert = [];
    let match;

    while ((match = listRegex.exec(xmlContent)) !== null) {
      const block = match[1];
      const stockCodeMatch = stockCodeRegex.exec(block);
      
      // Stock code exists and is a 6-digit number (listed company)
      if (stockCodeMatch && stockCodeMatch[1].trim().length === 6) {
        const ticker = stockCodeMatch[1].trim();
        const corpNameMatch = corpNameRegex.exec(block);
        const corpCodeMatch = corpCodeRegex.exec(block);

        if (corpNameMatch && corpCodeMatch) {
          listToInsert.push({
            ticker,
            corp_name: corpNameMatch[1].trim(),
            corp_code: corpCodeMatch[1].trim()
          });
        }
      }
    }

    console.log(`Parsed ${listToInsert.length} listed companies. Loading into database...`);

    // Insert using transaction for maximum performance
    await db.run('BEGIN TRANSACTION');
    await db.run('DELETE FROM corp_code_directory');
    
    const stmt = await db.prepare(
      'INSERT OR REPLACE INTO corp_code_directory (ticker, corp_name, corp_code) VALUES (?, ?, ?)'
    );

    for (const item of listToInsert) {
      await stmt.run([item.ticker, item.corp_name, item.corp_code]);
    }
    await stmt.finalize();

    // Also append the default ETFs for easy searching
    for (const etf of fallbackDirectory.filter(i => i.corp_code.startsWith('etf_'))) {
      await db.run(
        'INSERT OR REPLACE INTO corp_code_directory (ticker, corp_name, corp_code) VALUES (?, ?, ?)',
        [etf.ticker, etf.corp_name, etf.corp_code]
      );
    }

    await db.run('COMMIT');
    console.log(`[Corp Directory] Successfully populated search directory with ${listToInsert.length + 5} assets.`);

    // Clean up temp files
    try {
      if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
      if (fs.existsSync(XML_PATH)) fs.unlinkSync(XML_PATH);
      fs.rmdirSync(TEMP_DIR);
    } catch (cleanupErr) {
      // Ignored
    }

  } catch (err) {
    console.error('[Corp Directory] Failed to download/parse OpenDART XML. Falling back to local major stock database. Error:', err.message);
    await seedFallbackDirectory(db);
  }
}

async function seedFallbackDirectory(db) {
  await db.run('DELETE FROM corp_code_directory');
  for (const item of fallbackDirectory) {
    await db.run(
      'INSERT OR REPLACE INTO corp_code_directory (ticker, corp_name, corp_code) VALUES (?, ?, ?)',
      [item.ticker, item.corp_name, item.corp_code]
    );
  }
  console.log(`[Corp Directory] Initialized fallback directory with ${fallbackDirectory.length} major Korean assets & ETFs.`);
}
