const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_NAME = (process.env.ADMIN_NAME || 'Admin').toLowerCase();

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
    res.json({ success: true, name: clean, isAdmin: clean.toLowerCase() === ADMIN_NAME });
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
