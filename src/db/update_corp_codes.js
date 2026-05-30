import fs from 'fs';
import path from 'path';
import axios from 'axios';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';
import { getDb } from './db.js';

dotenv.config();

const DART_API_KEY = process.env.DART_API_KEY;
const TEMP_DIR = './data/temp';
const ZIP_PATH = path.join(TEMP_DIR, 'corp_codes.zip');
const XML_PATH = path.join(TEMP_DIR, 'CORPCODE.xml');

async function updateCorpCodes() {
  if (!DART_API_KEY) {
    console.warn('⚠️ WARNING: DART_API_KEY is not defined in your .env file.');
    console.warn('Please obtain a key from https://opendart.fss.or.kr/ and insert it into .env');
    console.warn('Skipping corp_code mapping.');
    process.exit(0);
  }

  const db = await getDb();

  // Get active assets with tickers
  const assets = await db.all('SELECT ticker, name FROM portfolio_asset WHERE asset_type = "stock"');
  if (assets.length === 0) {
    console.log('No stock assets found in the portfolio. Skipping corp_code mapping.');
    process.exit(0);
  }

  console.log(`Checking DART corp_codes for ${assets.length} stock assets...`);

  // Ensure temp directory exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  try {
    console.log('Downloading corpCode.xml from OpenDART API...');
    const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_API_KEY}`;
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'arraybuffer'
    });

    console.log('Saving zip file...');
    fs.writeFileSync(ZIP_PATH, response.data);

    console.log('Extracting CORPCODE.xml...');
    const zip = new AdmZip(ZIP_PATH);
    zip.extractAllTo(TEMP_DIR, true);

    if (!fs.existsSync(XML_PATH)) {
      throw new Error('Failed to find CORPCODE.xml inside the downloaded zip.');
    }

    console.log('Reading and parsing CORPCODE.xml...');
    const xmlContent = fs.readFileSync(XML_PATH, 'utf-8');

    // Parse XML using Regex for memory efficiency and speed
    const listRegex = /<list>([\s\S]*?)<\/list>/g;
    const corpCodeRegex = /<corp_code>(.*?)<\/corp_code>/;
    const stockCodeRegex = /<stock_code>(.*?)<\/stock_code>/;

    const tickerToCorpCodeMap = {};
    let match;

    while ((match = listRegex.exec(xmlContent)) !== null) {
      const block = match[1];
      const stockCodeMatch = stockCodeRegex.exec(block);
      
      // Stock code exists for listed companies (ETF/Index might not have standard stock_code in this xml, but we only query stocks)
      if (stockCodeMatch && stockCodeMatch[1].trim()) {
        const ticker = stockCodeMatch[1].trim();
        const corpCodeMatch = corpCodeRegex.exec(block);
        if (corpCodeMatch) {
          tickerToCorpCodeMap[ticker] = corpCodeMatch[1].trim();
        }
      }
    }

    console.log('Updating corp_codes in database...');
    let updatedCount = 0;
    for (const asset of assets) {
      const corpCode = tickerToCorpCodeMap[asset.ticker];
      if (corpCode) {
        await db.run(
          'UPDATE portfolio_asset SET corp_code = ? WHERE ticker = ?',
          [corpCode, asset.ticker]
        );
        console.log(`- Mapped ${asset.name} (${asset.ticker}) -> DART Corp Code: ${corpCode}`);
        updatedCount++;
      } else {
        console.warn(`- Could not find DART Corp Code for ${asset.name} (${asset.ticker})`);
      }
    }

    console.log(`Completed. Successfully updated ${updatedCount} assets.`);

    // Clean up temp files
    try {
      if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
      if (fs.existsSync(XML_PATH)) fs.unlinkSync(XML_PATH);
      fs.rmdirSync(TEMP_DIR);
      console.log('Cleaned up temporary files.');
    } catch (cleanupErr) {
      console.warn('Non-critical error during temp file cleanup:', cleanupErr.message);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error updating corp codes:', error.message);
    process.exit(1);
  }
}

updateCorpCodes();
