const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./db/schema');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize database
const db = initDatabase();

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
app.use('/api/notifications', require('./routes/notifications')(db));
app.use('/api/users', require('./routes/users')(db));
app.use('/api/community', require('./routes/community')(db));
app.use('/api/messages', require('./routes/messages')(db));
app.use('/api/settings', require('./routes/settings')(db));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

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
