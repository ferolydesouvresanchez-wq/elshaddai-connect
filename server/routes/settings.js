const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/settings/:key - Get a setting
  router.get('/:key', (req, res) => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(req.params.key);
    if (!row) return res.json({ key: req.params.key, value: null });
    try {
      res.json({ key: req.params.key, value: JSON.parse(row.value) });
    } catch {
      res.json({ key: req.params.key, value: row.value });
    }
  });

  // GET /api/settings - Get all settings
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM app_settings').all();
    const settings = {};
    rows.forEach(r => {
      try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
    });
    res.json(settings);
  });

  // PUT /api/settings/:key - Set a setting (admin only for most, but bannerPhotos etc.)
  router.put('/:key', (req, res) => {
    const { value } = req.body;
    const key = req.params.key;

    // Only admins can change bannerPhotos, userPermissions, rolePermissions
    const adminOnly = ['bannerPhotos', 'userPermissions', 'rolePermissions'];
    if (adminOnly.includes(key) && !['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    db.prepare(`
      INSERT INTO app_settings (key, value, updatedBy, updatedAt)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updatedBy = ?, updatedAt = datetime('now')
    `).run(key, serialized, req.user.id, serialized, req.user.id);

    res.json({ key, value });
  });

  return router;
};
