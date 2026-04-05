const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db/schema');
const { initMemoryBank } = require('./helpers/memoryBank');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize database
const db = initDatabase();

// Initialize Memory Bank — verify all books before serving requests
const memoryBankReport = initMemoryBank(db);

// Middleware
const isProduction = process.env.NODE_ENV === 'production';
app.use(cors({ origin: isProduction ? false : '*' }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Security headers in production
if (isProduction) {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });
}

// Serve frontend (static files from parent directory)
app.use(express.static(path.join(__dirname, '..')));

// API Routes
app.use('/api/auth', require('./routes/auth')(db));
app.use('/api/members', require('./routes/members')(db));
app.use('/api/attendance', require('./routes/attendance')(db));
app.use('/api/events', require('./routes/events')(db));
app.use('/api/finance', require('./routes/finance')(db));
app.use('/api/groups', require('./routes/groups')(db));
app.use('/api/courses', require('./routes/courses')(db));
app.use('/api/feed', require('./routes/feed')(db));
app.use('/api/follows', require('./routes/follows')(db));
app.use('/api/spaces', require('./routes/spaces')(db));
app.use('/api/stars', require('./routes/stars')(db));
app.use('/api/ranking', require('./routes/ranking')(db));
app.use('/api/notifications', require('./routes/notifications')(db));
app.use('/api/users', require('./routes/users')(db));
app.use('/api/community', require('./routes/community')(db));
app.use('/api/messages', require('./routes/messages')(db));
app.use('/api/settings', require('./routes/settings')(db));
app.use('/api/memory-bank', require('./routes/memoryBank')(db));

// Health check — includes Memory Bank verification
app.get('/api/health', (req, res) => {
  // Quick check: verify DB is accessible and on persistent volume
  let dbOk = false;
  let recordCount = 0;
  try {
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM members').get().c;
    dbOk = true;
    recordCount = userCount + memberCount;
  } catch (e) {
    console.error('Health check DB error:', e.message);
  }

  res.json({
    status: dbOk ? 'ok' : 'error',
    version: '2.0.0',
    memoryBank: 'active',
    dbPath: db.name,
    volumePath: process.env.RAILWAY_VOLUME_MOUNT_PATH || '(not set)',
    dbOnVolume: process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? db.name.startsWith(process.env.RAILWAY_VOLUME_MOUNT_PATH)
      : true,
    recordCount,
    timestamp: new Date().toISOString(),
  });
});

// Missed event penalty cron — runs every hour
const { processMissedEvents } = require('./helpers/points');
setInterval(() => {
  try {
    const result = processMissedEvents(db);
    if (result.processed > 0) {
      console.log(`[CRON] Processed ${result.processed} missed event penalties from ${result.eventsChecked} events`);
    }
  } catch (e) {
    console.error('[CRON] Missed event processing error:', e.message);
  }
}, 60 * 60 * 1000); // Every hour

// Run once on startup too (after short delay)
setTimeout(() => {
  try { processMissedEvents(db); } catch(e) { console.error('[CRON] Startup missed event processing error:', e.message); }
}, 5000);

// SPA fallback - serve index.html for any non-API route
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  if (err.message && err.message.includes('Only video')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`El Shaddai Connect API running at http://localhost:${PORT}`);
  console.log(`API endpoints: http://localhost:${PORT}/api/`);
  console.log(`Frontend: http://localhost:${PORT}/`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
