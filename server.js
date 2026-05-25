const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure db directory exists (Render persistent disk or local)
const DB_DIR = process.env.DB_PATH || path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_FILE = path.join(DB_DIR, 'sipnsnack.db');
const db = new Database(DB_FILE);

// Init DB schema
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    items TEXT NOT NULL,
    total_items INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────

// Get all known users
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT name FROM users ORDER BY name ASC').all();
  res.json(users.map(u => u.name));
});

// Register / login user (upsert)
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const clean = name.trim();
  db.prepare('INSERT OR IGNORE INTO users (name) VALUES (?)').run(clean);
  res.json({ success: true, name: clean });
});

// Submit an order
app.post('/api/orders', (req, res) => {
  const { name, items } = req.body;
  if (!name || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Name and items are required' });
  }

  const now = new Date();
  const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const totalItems = items.reduce((sum, i) => sum + (i.qty || 0), 0);
  const itemsJson = JSON.stringify(items);

  const stmt = db.prepare(`
    INSERT INTO orders (name, date, time, items, total_items)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name.trim(), date, time, itemsJson, totalItems);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Get orders by date (default: today)
app.get('/api/orders', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const orders = db.prepare(`
    SELECT * FROM orders WHERE date = ? ORDER BY created_at DESC
  `).all(date);

  const parsed = orders.map(o => ({
    ...o,
    items: JSON.parse(o.items)
  }));
  res.json(parsed);
});

// Get summary by date (grouped by item)
app.get('/api/summary', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const orders = db.prepare('SELECT * FROM orders WHERE date = ?').all(date);

  const summary = {};
  const userBreakdown = {};

  orders.forEach(o => {
    const items = JSON.parse(o.items);
    items.forEach(item => {
      summary[item.name] = (summary[item.name] || 0) + item.qty;
    });
    userBreakdown[o.name] = (userBreakdown[o.name] || []);
    items.forEach(item => {
      userBreakdown[o.name].push(item);
    });
  });

  res.json({ date, summary, userBreakdown, totalOrders: orders.length });
});

// Get all available dates that have orders
app.get('/api/dates', (req, res) => {
  const dates = db.prepare(`
    SELECT DISTINCT date FROM orders ORDER BY date DESC LIMIT 60
  `).all();
  res.json(dates.map(d => d.date));
});

// Get orders for a specific user
app.get('/api/orders/user/:name', (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE name = ? ORDER BY date DESC, created_at DESC LIMIT 50
  `).all(req.params.name);
  res.json(orders.map(o => ({ ...o, items: JSON.parse(o.items) })));
});

// Delete an order (admin-style, by id)
app.delete('/api/orders/:id', (req, res) => {
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Catch-all → serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`☕ Sip & Snack running on http://localhost:${PORT}`);
});
