import { getDb } from './src/db/db.js';

async function check() {
  const uid = 'Ohzuuk3w3oTQ2iTLuxkjr9feyzp1';
  const email = 'ydjava@gmail.com';
  const db = await getDb(uid, email);
  
  const events = await db.all(`
    SELECT e.ticker, a.name, e.event_date 
    FROM investment_event e
    JOIN portfolio_asset a ON e.ticker = a.ticker
    WHERE e.event_date >= date('2026-05-31', '-7 days')
  `);
  console.log('Events in last 7 days:', events);

  const activeAssets = await db.all('SELECT ticker, name FROM portfolio_asset WHERE is_active = 1');
  console.log('Active Assets:', activeAssets.length);
}

check();
