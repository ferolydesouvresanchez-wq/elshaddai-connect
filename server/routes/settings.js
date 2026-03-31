const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');

// Keys that are per-user (stored with userId prefix)
const USER_SCOPED_KEYS = ['bannerPhotos', 'bannerPositions', 'themePreference'];

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/settings/:key - Get a setting
  router.get('/:key', (req, res) => {
    const rawKey = req.params.key;
    // User-scoped keys are stored as "userId:key"
    const dbKey = USER_SCOPED_KEYS.includes(rawKey) ? `${req.user.id}:${rawKey}` : rawKey;
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(dbKey);
    if (!row) return res.json({ key: rawKey, value: null });
    try {
      res.json({ key: rawKey, value: JSON.parse(row.value) });
    } catch {
      res.json({ key: rawKey, value: row.value });
    }
  });

  // GET /api/settings - Get all settings
  router.get('/', (req, res) => {
    // Get global settings (non-user-scoped)
    const globalRows = db.prepare('SELECT key, value FROM app_settings WHERE key NOT LIKE ?').all('%:%');
    const settings = {};
    globalRows.forEach(r => {
      // Skip legacy global bannerPhotos/bannerPositions
      if (USER_SCOPED_KEYS.includes(r.key)) return;
      try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
    });

    // Get this user's scoped settings
    for (const scopedKey of USER_SCOPED_KEYS) {
      const dbKey = `${req.user.id}:${scopedKey}`;
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(dbKey);
      if (row) {
        try { settings[scopedKey] = JSON.parse(row.value); } catch { settings[scopedKey] = row.value; }
      }
      // If no user-scoped value, do NOT fall back to global — leave it undefined
    }

    res.json(settings);
  });

  // PUT /api/settings/:key - Set a setting
  router.put('/:key', (req, res) => {
    const { value } = req.body;
    const rawKey = req.params.key;

    // Only admins can change global admin settings
    const adminOnly = ['userPermissions', 'rolePermissions'];
    if (adminOnly.includes(rawKey) && !['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    // User-scoped keys are stored with userId prefix
    const dbKey = USER_SCOPED_KEYS.includes(rawKey) ? `${req.user.id}:${rawKey}` : rawKey;

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    db.prepare(`
      INSERT INTO app_settings (key, value, updatedBy, updatedAt)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updatedBy = ?, updatedAt = datetime('now')
    `).run(dbKey, serialized, req.user.id, serialized, req.user.id);

    res.json({ key: rawKey, value });
  });

  return router;
};
