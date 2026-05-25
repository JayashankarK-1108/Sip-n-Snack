# ☕ Sip & Snack

> Office Tea & Coffee Break Expense Manager

A friendly web app for tracking your team's tea, coffee, and snack orders during breaks.

---

## Features

- 🙋 **Name-based login** — no passwords, just your name
- ☕ **8 menu items** — Tea, Coffee, Lemon Tea, Lemon Tea with Honey, Buttermilk, Biscuits, Peanuts, Snacks
- 🔢 **Quantity selector** per item
- 📋 **Records view** — browse all orders by date with a day summary
- 👤 **My Orders** — view your personal order history
- 💾 **SQLite database** — persistent storage, zero config

---

## Local Development

```bash
npm install
npm start
# Open http://localhost:3000
```

---

## Deploy to Render.com

### Step-by-step:

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/sip-n-snack.git
   git push -u origin main
   ```

2. **Create a new Web Service on [render.com](https://render.com)**
   - Connect your GitHub repo
   - Render auto-detects `render.yaml` and configures everything

3. **Manual config (if needed)**
   | Setting | Value |
   |---|---|
   | Environment | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Disk Mount Path | `/var/data` |
   | Env Var: `DB_PATH` | `/var/data/db` |

4. **Deploy!** — your app will be live at `https://sip-n-snack.onrender.com`

> ⚠️ Use the **Render Disk** (persistent storage) so the SQLite DB survives redeploys. The `render.yaml` sets this up automatically with a 1GB disk.

---

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via `better-sqlite3`)
- **Frontend**: Vanilla HTML/CSS/JS — zero dependencies, fast load

---

## Menu Items & Suggested Prices

| Item | Emoji | Suggested Price |
|---|---|---|
| Tea | 🍵 | ₹5 |
| Coffee | ☕ | ₹8 |
| Lemon Tea | 🍋 | ₹8 |
| Lemon Tea with Honey | 🍯 | ₹10 |
| Buttermilk | 🥛 | ₹10 |
| Biscuits | 🍪 | ₹5 |
| Peanuts | 🥜 | ₹10 |
| Snacks | 🧆 | ₹15 |

Prices are display-only and can be customized in `public/index.html` under the `MENU` array.
