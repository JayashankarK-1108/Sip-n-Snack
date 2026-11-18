const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_NAME = (process.env.ADMIN_NAME || 'Admin').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_UPI = process.env.ADMIN_UPI || '';

function isAdminRequest(req) {
  return (req.headers['x-user-name'] || '').toLowerCase() === ADMIN_NAME;
}

// Neon PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Init DB schema
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      items TEXT NOT NULL,
      total_items INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS week_payments (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL,
      week_start TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      paid_at TIMESTAMP,
      paid_by TEXT,
      UNIQUE (user_name, week_start)
    );

    CREATE TABLE IF NOT EXISTS wallet_topups (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      added_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('☕ Database ready');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────

// Get all known users
app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name FROM users ORDER BY name ASC');
    res.json(rows.map(u => u.name));
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Register / login user (upsert)
app.post('/api/login', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const clean = name.trim();
  try {
    await pool.query('INSERT INTO users (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [clean]);
    const adminFlag = clean.toLowerCase() === ADMIN_NAME;
    res.json({ success: true, name: clean, isAdmin: adminFlag, adminName: ADMIN_NAME, upiId: ADMIN_UPI });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Admin login with password
app.post('/api/admin-login', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  const clean = ADMIN_NAME.charAt(0).toUpperCase() + ADMIN_NAME.slice(1);
  try {
    await pool.query('INSERT INTO users (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [clean]);
    res.json({ success: true, name: clean, isAdmin: true, adminName: ADMIN_NAME, upiId: ADMIN_UPI });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Submit an order
app.post('/api/orders', async (req, res) => {
  const { name, items } = req.body;
  if (!name || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Name and items are required' });
  }

  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD in IST
  const time = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  const totalItems = items.reduce((sum, i) => sum + (i.qty || 0), 0);
  // Store the price at order time so later price changes don't alter past deductions
  const itemsJson = JSON.stringify(items.map(i => ({ ...i, price: srvItemPrice(i.id) })));
  const clean = name.trim();

  try {
    const { rows } = await pool.query(
      'INSERT INTO orders (name, date, time, items, total_items) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [clean, date, time, itemsJson, totalItems]
    );
    const wallet = clean.toLowerCase() === ADMIN_NAME ? null : (await computeWallets([clean]))[clean];
    res.json({ success: true, id: rows[0].id, balance: wallet ? wallet.balance : null });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Get orders by date (default: today) — admin only
app.get('/api/orders', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE date = $1 ORDER BY created_at DESC',
      [date]
    );
    res.json(rows.map(o => ({ ...o, items: JSON.parse(o.items) })));
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Get summary by date (grouped by item) — admin only
app.get('/api/summary', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE date = $1', [date]);

    const summary = {};
    const userBreakdown = {};

    rows.forEach(o => {
      const items = JSON.parse(o.items);
      items.forEach(item => {
        summary[item.name] = (summary[item.name] || 0) + item.qty;
      });
      userBreakdown[o.name] = userBreakdown[o.name] || [];
      items.forEach(item => userBreakdown[o.name].push(item));
    });

    res.json({ date, summary, userBreakdown, totalOrders: rows.length });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Get all available dates that have orders — admin only
app.get('/api/dates', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT date FROM orders ORDER BY date DESC LIMIT 60'
    );
    res.json(rows.map(d => d.date));
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Get all orders for a date (public — used for snack share calculation)
app.get('/api/orders/date/:date', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, time, items FROM orders WHERE date = $1 ORDER BY created_at DESC',
      [req.params.date]
    );
    res.json(rows.map(o => ({ name: o.name, time: o.time, items: JSON.parse(o.items) })));
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Get orders for a user in a date range (for payments)
app.get('/api/orders/user/:name/range', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE name = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC, created_at ASC',
      [req.params.name, from, to]
    );
    res.json(rows.map(o => ({ ...o, items: JSON.parse(o.items) })));
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Get orders for a specific user
app.get('/api/orders/user/:name', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE name = $1 ORDER BY date DESC, created_at DESC LIMIT 50',
      [req.params.name]
    );
    res.json(rows.map(o => ({ ...o, items: JSON.parse(o.items) })));
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Delete an order — admin only
app.delete('/api/orders/:id', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Wallet endpoints ─────────────────────────────────────

// Prices & snack IDs mirroring the frontend MENU
const PRICES = {
  tea: 15, coffee: 15, lemon_tea: 17, honey_tea: 18, buttermilk: 20,
  biscuits: 18, peanuts: 20, samosa: 15, egg_puffs: 15, paneer_puffs: 15, masala_corn: 32,
  horlicks: 20,
  mc_coffee: 24, mc_tea: 24, mc_buttermilk: 22, mc_milk: 23, mc_samosa: 28,
  mc_boost: 30, mc_horlicks: 30, mc_badam: 30, mc_cookies: 15, mc_bajji: 15
};
const SNACK_IDS = new Set(['biscuits', 'peanuts', 'samosa', 'egg_puffs', 'paneer_puffs', 'masala_corn']);
const DEFAULT_TOPUP = 400;

function srvItemPrice(id) { return PRICES[id] || 0; }
// Price stored on the order item wins; older orders fall back to the current price list
function srvLinePrice(i) { return (Number.isFinite(i.price) ? i.price : srvItemPrice(i.id)) * i.qty; }
function srvSnackTotal(items) {
  return items.reduce((s, i) => SNACK_IDS.has(i.id) ? s + srvLinePrice(i) : s, 0);
}
function srvOrderTotal(items) {
  return items.reduce((s, i) => s + srvLinePrice(i), 0);
}
function srvParseHour(timeStr) {
  const [timePart, period] = timeStr.toLowerCase().split(' ');
  let [h] = timePart.split(':').map(Number);
  if (period === 'pm' && h !== 12) h += 12;
  if (period === 'am' && h === 12) h = 0;
  return h;
}
function srvSession(timeStr) { return srvParseHour(timeStr) < 16 ? 'morning' : 'evening'; }
function istDate(ts) { return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }

// Admin's snack orders in a session are split equally among the non-admin users who ordered in it
function sessionSnackShares(dayOrders) {
  const shares = { morning: 0, evening: 0 };
  for (const session of ['morning', 'evening']) {
    const sessOrders = dayOrders.filter(o => srvSession(o.time) === session);
    const snackPool = sessOrders.filter(o => o.name.toLowerCase() === ADMIN_NAME)
      .reduce((s, o) => s + srvSnackTotal(o.items), 0);
    const uCount = new Set(sessOrders.map(o => o.name).filter(n => n.toLowerCase() !== ADMIN_NAME)).size;
    shares[session] = uCount > 0 ? Math.round((snackPool / uCount) / 0.5) * 0.5 : 0;
  }
  return shares;
}

// Wallets start on the date of the very first top-up; earlier orders were settled under the old weekly payments
async function walletStartDate() {
  const { rows } = await pool.query('SELECT MIN(created_at) AS first FROM wallet_topups');
  return rows[0].first ? istDate(rows[0].first) : null;
}

// Returns { [name]: { credited, spent, balance, ledger } } — ledger is newest first, each entry with running balance
async function computeWallets(names) {
  const result = {};
  names.forEach(n => { result[n] = { credited: 0, spent: 0, balance: 0, ledger: [] }; });
  if (names.length === 0) return result;

  const startDate = await walletStartDate();
  if (!startDate) return result;

  const { rows: topups } = await pool.query(
    'SELECT id, user_name, amount, added_by, created_at FROM wallet_topups WHERE user_name = ANY($1) ORDER BY created_at ASC',
    [names]
  );
  const { rows: orderRows } = await pool.query(
    'SELECT name, date, time, items FROM orders WHERE date >= $1 ORDER BY date ASC, created_at ASC',
    [startDate]
  );
  const orders = orderRows.map(o => ({ ...o, items: JSON.parse(o.items) }));

  const byDate = {};
  orders.forEach(o => { (byDate[o.date] = byDate[o.date] || []).push(o); });
  const sharesByDate = {};
  for (const date in byDate) sharesByDate[date] = sessionSnackShares(byDate[date]);

  for (const name of names) {
    const entries = topups.filter(t => t.user_name === name).map(t => ({
      type: 'topup', id: t.id, date: istDate(t.created_at), at: t.created_at,
      amount: Number(t.amount), addedBy: t.added_by
    }));

    const userDays = {};
    orders.filter(o => o.name === name).forEach(o => {
      const day = userDays[o.date] = userDays[o.date] || { morning: [], evening: [] };
      day[srvSession(o.time)].push(o);
    });
    for (const date in userDays) {
      const day = userDays[date];
      const shares = sharesByDate[date];
      const morning = day.morning.reduce((s, o) => s + srvOrderTotal(o.items), 0);
      const evening = day.evening.reduce((s, o) => s + srvOrderTotal(o.items), 0);
      const snack = (day.morning.length ? shares.morning : 0) + (day.evening.length ? shares.evening : 0);
      entries.push({ type: 'day', date, morning, evening, snack, amount: morning + evening + snack });
    }

    // Oldest first; on the same day a top-up is applied before that day's orders
    const rank = e => (e.type === 'topup' ? 0 : 1);
    entries.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b));
    const w = result[name];
    for (const e of entries) {
      if (e.type === 'topup') w.credited += e.amount;
      else w.spent += e.amount;
      e.balance = w.credited - w.spent;
    }
    w.balance = w.credited - w.spent;
    w.ledger = entries.reverse();
  }
  return result;
}

// GET /api/wallet/:name — balance and ledger for one user
app.get('/api/wallet/:name', async (req, res) => {
  const name = req.params.name;
  try {
    const w = (await computeWallets([name]))[name];
    res.json({ userName: name, credited: w.credited, spent: w.spent, balance: w.balance, ledger: w.ledger.slice(0, 60) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/wallets — admin only, balances for every associate
app.get('/api/wallets', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows } = await pool.query('SELECT name FROM users ORDER BY name ASC');
    const names = rows.map(r => r.name).filter(n => n.toLowerCase() !== ADMIN_NAME);
    const wallets = await computeWallets(names);
    res.json({
      defaultTopup: DEFAULT_TOPUP,
      users: names.map(name => {
        const w = wallets[name];
        const lastTopup = w.ledger.find(e => e.type === 'topup') || null;
        return { userName: name, credited: w.credited, spent: w.spent, balance: w.balance, lastTopup };
      })
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/wallet/topup — admin only, credit an associate's wallet
app.post('/api/wallet/topup', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  const { userName } = req.body;
  const amount = Number(req.body.amount ?? DEFAULT_TOPUP);
  if (!userName) return res.status(400).json({ error: 'userName required' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO wallet_topups (user_name, amount, added_by) VALUES ($1, $2, $3) RETURNING id',
      [userName, amount, req.headers['x-user-name']]
    );
    const w = (await computeWallets([userName]))[userName];
    res.json({ success: true, id: rows[0].id, balance: w.balance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE /api/wallet/topup/:id — admin only, undo a mistaken top-up
app.delete('/api/wallet/topup/:id', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  try {
    await pool.query('DELETE FROM wallet_topups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Catch-all → serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`☕ Sip & Snack running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to database:', err.message);
  process.exit(1);
});
