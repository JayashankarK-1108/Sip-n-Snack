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
  const itemsJson = JSON.stringify(items);

  try {
    const { rows } = await pool.query(
      'INSERT INTO orders (name, date, time, items, total_items) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name.trim(), date, time, itemsJson, totalItems]
    );
    res.json({ success: true, id: rows[0].id });
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

// ── Payment endpoints ────────────────────────────────────

// Prices & snack IDs mirroring the frontend MENU
const PRICES = {
  tea: 15, coffee: 15, lemon_tea: 17, honey_tea: 18, buttermilk: 20,
  biscuits: 5, peanuts: 20, samosa: 15, egg_puffs: 15, paneer_puffs: 15,
  mc_coffee: 24, mc_tea: 24, mc_buttermilk: 22, mc_milk: 23, mc_samosa: 28,
  mc_boost: 30, mc_horlicks: 30, mc_badam: 30, mc_cookies: 15, mc_bajji: 15
};
const SNACK_IDS = new Set(['biscuits', 'peanuts', 'samosa', 'egg_puffs', 'paneer_puffs']);

function srvItemPrice(id) { return PRICES[id] || 0; }
function srvSnackTotal(items) {
  return items.reduce((s, i) => SNACK_IDS.has(i.id) ? s + srvItemPrice(i.id) * i.qty : s, 0);
}
function srvNonSnackTotal(items) {
  return items.reduce((s, i) => !SNACK_IDS.has(i.id) ? s + srvItemPrice(i.id) * i.qty : s, 0);
}
function srvParseHour(timeStr) {
  const [timePart, period] = timeStr.toLowerCase().split(' ');
  let [h] = timePart.split(':').map(Number);
  if (period === 'pm' && h !== 12) h += 12;
  if (period === 'am' && h === 12) h = 0;
  return h;
}

// GET /api/payments/week/:weekStart — admin only, returns all users totals + payment status
app.get('/api/payments/week/:weekStart', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  const { weekStart } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'Invalid date' });

  try {
    const monday = new Date(weekStart + 'T00:00:00Z');
    const dates = Array.from({ length: 5 }, (_, i) => {
      const d = new Date(monday);
      d.setUTCDate(monday.getUTCDate() + i);
      return d.toISOString().split('T')[0];
    });
    const weekEnd = dates[4];

    const { rows: allOrders } = await pool.query(
      'SELECT name, date, time, items FROM orders WHERE date >= $1 AND date <= $2',
      [weekStart, weekEnd]
    );
    const parsed = allOrders.map(o => ({ ...o, items: JSON.parse(o.items) }));

    // Only include users who ordered this week (excluding admin)
    const weekUserNames = [...new Set(
      parsed.filter(o => o.name.toLowerCase() !== ADMIN_NAME).map(o => o.name)
    )].sort();
    const userRows = weekUserNames.map(name => ({ name }));

    // Snack share per date
    const dateSnackShare = {};
    for (const date of dates) {
      const dayOrders = parsed.filter(o => o.date === date);
      const pool2 = dayOrders.filter(o => o.name.toLowerCase() === ADMIN_NAME)
        .reduce((s, o) => s + srvSnackTotal(o.items), 0);
      const uCount = [...new Set(dayOrders.map(o => o.name))]
        .filter(n => n.toLowerCase() !== ADMIN_NAME).length;
      dateSnackShare[date] = uCount > 0 ? Math.round((pool2 / uCount) / 0.5) * 0.5 : 0;
    }

    // Per-user totals
    const { rows: payRows } = await pool.query(
      'SELECT user_name, status, paid_at, paid_by FROM week_payments WHERE week_start = $1', [weekStart]
    );
    const payMap = {};
    payRows.forEach(p => { payMap[p.user_name] = p; });

    const result = userRows.map(({ name }) => {
      const userOrders = parsed.filter(o => o.name === name);
      let morning = 0, evening = 0, snack = 0;
      for (const date of dates) {
        const dayUser = userOrders.filter(o => o.date === date);
        if (dayUser.length === 0) continue;
        snack += dateSnackShare[date] || 0;
        dayUser.forEach(o => {
          const total = srvNonSnackTotal(o.items) + srvSnackTotal(o.items);
          if (srvParseHour(o.time) < 16) morning += total;
          else evening += total;
        });
      }
      return {
        userName: name,
        morning, evening, snack,
        total: morning + evening + snack,
        status: payMap[name]?.status || 'unpaid',
        paidAt: payMap[name]?.paid_at || null,
        paidBy: payMap[name]?.paid_by || null
      };
    });

    res.json({ weekStart, weekEnd, users: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/payments/mark-paid — admin only
app.post('/api/payments/mark-paid', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin only' });
  const { userName, weekStart } = req.body;
  if (!userName || !weekStart) return res.status(400).json({ error: 'userName and weekStart required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'Invalid date' });
  try {
    await pool.query(
      `INSERT INTO week_payments (user_name, week_start, status, paid_at, paid_by)
       VALUES ($1, $2, 'paid', NOW(), $3)
       ON CONFLICT (user_name, week_start)
       DO UPDATE SET status = 'paid', paid_at = NOW(), paid_by = $3`,
      [userName, weekStart, req.headers['x-user-name']]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/payments/status/:userName/:weekStart — public
app.get('/api/payments/status/:userName/:weekStart', async (req, res) => {
  const { userName, weekStart } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return res.status(400).json({ error: 'Invalid date' });
  try {
    const { rows } = await pool.query(
      'SELECT status, paid_at, paid_by FROM week_payments WHERE user_name = $1 AND week_start = $2',
      [userName, weekStart]
    );
    if (rows.length === 0) return res.json({ status: 'unpaid', paidAt: null });
    res.json({ status: rows[0].status, paidAt: rows[0].paid_at, paidBy: rows[0].paid_by });
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
