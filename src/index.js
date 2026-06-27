require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const foodRouter = require('./routes/food');
const { getDb } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3101;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Auth tối giản tuỳ chọn: đặt AUTH_TOKEN để yêu cầu header "x-auth-token".
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN || req.path === '/health') return next();
  if (req.get('x-auth-token') === AUTH_TOKEN) return next();
  res.status(401).json({ success: false, error: 'Unauthorized' });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'foodwatch', ts: Date.now() }));
app.use('/api/food', foodRouter);

// Dashboard tĩnh (public/index.html)
app.use(express.static(path.join(__dirname, '../public')));

app.use((e, req, res, next) => { console.error(e); res.status(500).json({ success: false, error: e.message }); });

getDb(); // khởi tạo schema sớm
require('./services/scheduler').start(); // tự động quét định kỳ (chỉ chạy khi bật trong cài đặt)
app.listen(PORT, () => console.log(`FoodWatch API: http://localhost:${PORT}  (health: /api/health)`));
