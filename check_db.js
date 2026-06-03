import { getDb } from './src/db/db.js';

async function check() {
  const uid = 'Ohzuuk3w3oTQ2iTLuxkjr9feyzp1';
  const email = 'ydjava@gmail.com';
  const db = await getDb(uid, email);
  
  const assets = await db.all('SELECT count(*) as count FROM portfolio_asset');
  console.log(`Assets: ${assets[0].count}`);
  
  const events = await db.all('SELECT event_date, count(*) as count FROM investment_event GROUP BY event_date ORDER BY event_date DESC LIMIT 5');
  console.log('Latest Events:', events);
}

check();
