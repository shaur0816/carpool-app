const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 資料庫設定 ──────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'carpool.db');
const db = new Database(DB_PATH);

// 開啟 WAL 模式，提升效能
db.pragma('journal_mode = WAL');

// 建立資料表
db.exec(`
  CREATE TABLE IF NOT EXISTS trips (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL CHECK(type IN ('go','return')),
    from_loc  TEXT NOT NULL,
    to_loc    TEXT NOT NULL,
    date      TEXT NOT NULL,
    time      TEXT NOT NULL,
    note      TEXT DEFAULT '',
    max_seats INTEGER DEFAULT 20,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS passengers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id    INTEGER NOT NULL,
    slot_index INTEGER NOT NULL,
    name       TEXT NOT NULL,
    joined_at  TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    UNIQUE(trip_id, slot_index)
  );
`);

// ── 預設班次資料（只有當資料庫空白時才插入）──────────
const existingTrips = db.prepare('SELECT COUNT(*) as c FROM trips').get();
if (existingTrips.c === 0) {
  const insertTrip = db.prepare(`
    INSERT INTO trips (type, from_loc, to_loc, date, time, note, sort_order)
    VALUES (@type, @from_loc, @to_loc, @date, @time, @note, @sort_order)
  `);
  const insertPassenger = db.prepare(`
    INSERT INTO passengers (trip_id, slot_index, name) VALUES (?, ?, ?)
  `);

  const seedTrips = [
    // 去程
    { type:'go', from_loc:'台中高鐵', to_loc:'菘畫居', date:'04/16（四）', time:'15:40', note:'提前一天入住菘畫居', sort_order:1 },
    { type:'go', from_loc:'台中高鐵', to_loc:'菘畫居', date:'04/17（五）', time:'15:40', note:'提前一天入住菘畫居', sort_order:2 },
    { type:'go', from_loc:'台中高鐵', to_loc:'菘畫居', date:'04/17（五）', time:'07:30', note:'當天進階修部上課',   sort_order:3 },
    { type:'go', from_loc:'台中高鐵', to_loc:'菘畫居', date:'04/18（六）', time:'07:30', note:'當天見部上課',      sort_order:4 },
    { type:'go', from_loc:'台中高鐵', to_loc:'菘畫居', date:'04/19（日）', time:'07:30', note:'當天修部上課',      sort_order:5 },
    // 回程
    { type:'return', from_loc:'菘畫居', to_loc:'台中高鐵', date:'04/17（五）', time:'17:30', note:'見部下課發車🚗', sort_order:6 },
    { type:'return', from_loc:'菘畫居', to_loc:'台中高鐵', date:'04/18（六）', time:'17:30', note:'見部下課發車🚗', sort_order:7 },
    { type:'return', from_loc:'菘畫居', to_loc:'台中高鐵', date:'04/19（日）', time:'17:10', note:'修部下課發車🚗', sort_order:8 },
  ];

  const seedPassengers = {
    1: ['洪千淑'],
    2: ['洪千淑'],
    3: ['孫光灝','王美鳳'],
    4: ['孫光灝','王美鳳','林美玉','戴榮元','陳淑珍','任冰如','林慧珠','黃水華'],
    5: ['郭淑惠（馥萱）','陳萃英','葉啟立'],
    6: [],
    7: ['孫光灝','王美鳳','張玉梅','俞水珍','戴榮元','林慧珠','黃薇儒'],
    8: ['林滄雄','尤秀娟','翁綵眉','林美玉','陳淑珍','任冰如','郭淑惠（馥萱）','陳萃英','葉啟立','張宸鴻'],
  };

  const insertMany = db.transaction(() => {
    seedTrips.forEach((t, idx) => {
      const result = insertTrip.run(t);
      const tid = result.lastInsertRowid;
      const passengers = seedPassengers[idx + 1] || [];
      passengers.forEach((name, si) => {
        insertPassenger.run(tid, si, name);
      });
    });
  });
  insertMany();
  console.log('✅ 預設班次資料已建立');
}

// ── Middleware ──────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 工具函式 ────────────────────────────────────────
function getTripsWithPassengers(type) {
  const trips = db.prepare(
    'SELECT * FROM trips WHERE type = ? ORDER BY sort_order ASC, id ASC'
  ).all(type);

  return trips.map(trip => {
    const passengers = db.prepare(
      'SELECT slot_index, name, joined_at FROM passengers WHERE trip_id = ? ORDER BY slot_index ASC'
    ).all(trip.id);

    // 建立 slots 陣列：填入已報名者，空位為 null
    const maxFilled = passengers.length > 0
      ? Math.max(...passengers.map(p => p.slot_index)) + 1
      : 0;
    const slotCount = Math.max(maxFilled + 1, 4); // 至少4個座位，且末尾多1空位
    const slots = Array(Math.min(slotCount, trip.max_seats)).fill(null);
    passengers.forEach(p => {
      if (p.slot_index < slots.length) slots[p.slot_index] = { name: p.name, joined_at: p.joined_at };
    });

    return {
      id: trip.id,
      type: trip.type,
      from: trip.from_loc,
      to: trip.to_loc,
      date: trip.date,
      time: trip.time,
      note: trip.note,
      maxSeats: trip.max_seats,
      filledCount: passengers.length,
      slots,
    };
  });
}

// ── API 路由 ────────────────────────────────────────

// 取得所有班次（去程或回程）
app.get('/api/trips/:type', (req, res) => {
  const { type } = req.params;
  if (!['go','return'].includes(type)) return res.status(400).json({ error: '無效的類型' });
  try {
    res.json(getTripsWithPassengers(type));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// 報名搭乘
app.post('/api/trips/:tripId/join', (req, res) => {
  const tripId = parseInt(req.params.tripId);
  const { name, slotIndex } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '請輸入姓名' });
  }
  if (typeof slotIndex !== 'number' || slotIndex < 0) {
    return res.status(400).json({ error: '無效的座位編號' });
  }

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return res.status(404).json({ error: '找不到此班次' });

  // 檢查人數上限
  const count = db.prepare('SELECT COUNT(*) as c FROM passengers WHERE trip_id = ?').get(tripId).c;
  if (count >= trip.max_seats) return res.status(400).json({ error: '此班次已額滿' });

  // 檢查座位是否已被佔用
  const existing = db.prepare('SELECT * FROM passengers WHERE trip_id = ? AND slot_index = ?').get(tripId, slotIndex);
  if (existing) return res.status(400).json({ error: '此座位已有人報名' });

  try {
    db.prepare('INSERT INTO passengers (trip_id, slot_index, name) VALUES (?, ?, ?)').run(tripId, slotIndex, name.trim());
    res.json({ success: true, message: `${name.trim()} 報名成功！` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '報名失敗，請重試' });
  }
});

// 取消報名
app.delete('/api/trips/:tripId/cancel/:slotIndex', (req, res) => {
  const tripId = parseInt(req.params.tripId);
  const slotIndex = parseInt(req.params.slotIndex);

  const passenger = db.prepare(
    'SELECT * FROM passengers WHERE trip_id = ? AND slot_index = ?'
  ).get(tripId, slotIndex);

  if (!passenger) return res.status(404).json({ error: '找不到此報名紀錄' });

  try {
    db.prepare('DELETE FROM passengers WHERE trip_id = ? AND slot_index = ?').run(tripId, slotIndex);
    res.json({ success: true, message: `${passenger.name} 已取消報名` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '取消失敗，請重試' });
  }
});

// 新增座位（空位）
app.post('/api/trips/:tripId/add-slot', (req, res) => {
  const tripId = parseInt(req.params.tripId);
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return res.status(404).json({ error: '找不到此班次' });

  const count = db.prepare('SELECT COUNT(*) as c FROM passengers WHERE trip_id = ?').get(tripId).c;
  if (count >= trip.max_seats) return res.status(400).json({ error: '已達上限20人' });

  // 回傳最新資料即可（空位由前端根據 slots 陣列長度顯示）
  res.json({ success: true });
});

// 新增班次
app.post('/api/trips', (req, res) => {
  const { type, from, to, date, time, note } = req.body;
  if (!type || !from || !to || !date || !time) {
    return res.status(400).json({ error: '請填寫所有必填欄位' });
  }
  if (!['go','return'].includes(type)) return res.status(400).json({ error: '無效的類型' });

  try {
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM trips').get().m || 0;
    const result = db.prepare(
      'INSERT INTO trips (type, from_loc, to_loc, date, time, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(type, from.trim(), to.trim(), date.trim(), time.trim(), (note||'').trim(), maxOrder + 1);

    res.json({ success: true, id: result.lastInsertRowid, message: '班次已新增' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '新增失敗' });
  }
});

// ── 長輪詢（即時更新）──────────────────────────────
// 前端每5秒輪詢一次，拿到最新資料
app.get('/api/poll', (req, res) => {
  try {
    const go = getTripsWithPassengers('go');
    const ret = getTripsWithPassengers('return');
    res.json({ go, return: ret, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── SPA Fallback ────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚗 共乘登記系統啟動中，Port: ${PORT}`);
});
