const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');
const { encrypt, decrypt, maskKey } = require('../helpers/encryption');

module.exports = function(db) {
  const router = express.Router();

  // All studio routes require authentication
  router.use(authenticate);

  // ==========================================
  // STREAM PLATFORMS (Stream Keys)
  // ==========================================

  // GET /api/studio/platforms — list platforms (keys masked)
  router.get('/platforms', (req, res) => {
    const platforms = db.prepare(
      'SELECT id, userId, platform, rtmpUrl, enabled, label, createdAt FROM stream_platforms WHERE userId = ? ORDER BY platform'
    ).all(req.user.id);
    // Return with masked keys
    const result = platforms.map(p => {
      const decryptedKey = decrypt(
        db.prepare('SELECT encryptedKey FROM stream_platforms WHERE id = ?').get(p.id)?.encryptedKey
      );
      return { ...p, maskedKey: maskKey(decryptedKey), hasKey: !!decryptedKey };
    });
    res.json(result);
  });

  // POST /api/studio/platforms — add/update a platform stream key
  router.post('/platforms', (req, res) => {
    const { platform, rtmpUrl, streamKey, label, enabled } = req.body;
    if (!platform || !rtmpUrl || !streamKey) {
      return res.status(400).json({ error: 'platform, rtmpUrl, and streamKey are required' });
    }

    const encryptedKey = encrypt(streamKey);
    const id = uuidv4();

    // Upsert: if platform already exists for this user, update it
    const existing = db.prepare(
      'SELECT id FROM stream_platforms WHERE userId = ? AND platform = ?'
    ).get(req.user.id, platform);

    if (existing) {
      db.prepare(
        `UPDATE stream_platforms SET rtmpUrl = ?, encryptedKey = ?, label = ?, enabled = ?, updatedAt = datetime('now') WHERE id = ?`
      ).run(rtmpUrl, encryptedKey, label || platform, enabled !== false ? 1 : 0, existing.id);
      res.json({ id: existing.id, message: 'Platform updated' });
    } else {
      db.prepare(
        `INSERT INTO stream_platforms (id, userId, platform, rtmpUrl, encryptedKey, label, enabled, createdAt) VALUES (?,?,?,?,?,?,?,datetime('now'))`
      ).run(id, req.user.id, platform, rtmpUrl, encryptedKey, label || platform, enabled !== false ? 1 : 0);
      res.json({ id, message: 'Platform added' });
    }
  });

  // DELETE /api/studio/platforms/:id
  router.delete('/platforms/:id', (req, res) => {
    db.prepare('DELETE FROM stream_platforms WHERE id = ? AND userId = ?').run(req.params.id, req.user.id);
    res.json({ message: 'Platform deleted' });
  });

  // POST /api/studio/platforms/:id/toggle — enable/disable
  router.post('/platforms/:id/toggle', (req, res) => {
    const platform = db.prepare('SELECT * FROM stream_platforms WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
    if (!platform) return res.status(404).json({ error: 'Platform not found' });
    db.prepare('UPDATE stream_platforms SET enabled = ? WHERE id = ?').run(platform.enabled ? 0 : 1, req.params.id);
    res.json({ enabled: !platform.enabled });
  });

  // GET /api/studio/platforms/:id/key — decrypt key (superadmin only, for relay server)
  router.get('/platforms/:id/key', requireRole('superadmin', 'admin'), (req, res) => {
    const platform = db.prepare('SELECT encryptedKey, rtmpUrl FROM stream_platforms WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
    if (!platform) return res.status(404).json({ error: 'Platform not found' });
    const key = decrypt(platform.encryptedKey);
    res.json({ rtmpUrl: platform.rtmpUrl, streamKey: key });
  });

  // GET /api/studio/active-keys — get all enabled platform keys for streaming (internal use)
  router.get('/active-keys', (req, res) => {
    const platforms = db.prepare(
      'SELECT id, platform, rtmpUrl, encryptedKey, label FROM stream_platforms WHERE userId = ? AND enabled = 1'
    ).all(req.user.id);
    const result = platforms.map(p => ({
      id: p.id,
      platform: p.platform,
      label: p.label,
      rtmpUrl: p.rtmpUrl,
      streamKey: decrypt(p.encryptedKey),
    }));
    res.json(result);
  });

  // ==========================================
  // STUDIO PRESETS (Lower Thirds, Announcements, etc.)
  // ==========================================

  // GET /api/studio/presets?type=lower_third
  router.get('/presets', (req, res) => {
    const { type } = req.query;
    let query = 'SELECT * FROM studio_presets WHERE userId = ?';
    const params = [req.user.id];
    if (type) { query += ' AND type = ?'; params.push(type); }
    query += ' ORDER BY createdAt DESC';
    const presets = db.prepare(query).all(...params);
    // Parse config JSON
    res.json(presets.map(p => ({ ...p, config: JSON.parse(p.config || '{}') })));
  });

  // POST /api/studio/presets
  router.post('/presets', (req, res) => {
    const { type, name, config } = req.body;
    if (!type || !name) return res.status(400).json({ error: 'type and name required' });
    const id = uuidv4();
    db.prepare(
      `INSERT INTO studio_presets (id, userId, type, name, config, createdAt) VALUES (?,?,?,?,?,datetime('now'))`
    ).run(id, req.user.id, type, name, JSON.stringify(config || {}));
    res.json({ id, message: 'Preset saved' });
  });

  // PUT /api/studio/presets/:id
  router.put('/presets/:id', (req, res) => {
    const { name, config } = req.body;
    db.prepare(
      `UPDATE studio_presets SET name = ?, config = ?, updatedAt = datetime('now') WHERE id = ? AND userId = ?`
    ).run(name, JSON.stringify(config || {}), req.params.id, req.user.id);
    res.json({ message: 'Preset updated' });
  });

  // DELETE /api/studio/presets/:id
  router.delete('/presets/:id', (req, res) => {
    db.prepare('DELETE FROM studio_presets WHERE id = ? AND userId = ?').run(req.params.id, req.user.id);
    res.json({ message: 'Preset deleted' });
  });

  // ==========================================
  // STREAM SESSIONS
  // ==========================================

  // POST /api/studio/sessions — start a new session
  router.post('/sessions', (req, res) => {
    const { title, platforms } = req.body;
    const id = uuidv4();
    db.prepare(
      `INSERT INTO stream_sessions (id, hostId, title, status, platforms, startedAt) VALUES (?,?,?,?,?,datetime('now'))`
    ).run(id, req.user.id, title || 'Live Stream', 'live', JSON.stringify(platforms || []));

    // Send notification to all users
    const users = db.prepare('SELECT id FROM users WHERE active = 1 AND id != ?').all(req.user.id);
    const insertNotif = db.prepare(
      `INSERT INTO notifications (id, userId, type, title, message, refId, createdAt) VALUES (?,?,?,?,?,?,datetime('now'))`
    );
    const notifyAll = db.transaction((userList) => {
      for (const u of userList) {
        insertNotif.run(uuidv4(), u.id, 'live_stream', 'We are LIVE!',
          'Glory of El Shaddai is live now — join us!', id);
      }
    });
    notifyAll(users);

    res.json({ id, message: 'Stream session started', notified: users.length });
  });

  // PUT /api/studio/sessions/:id/end — end session
  router.put('/sessions/:id/end', (req, res) => {
    const { viewerCount, transcript, versesUsed } = req.body;
    db.prepare(
      `UPDATE stream_sessions SET status = ?, endedAt = datetime('now'), viewerCount = ? WHERE id = ? AND hostId = ?`
    ).run('ended', viewerCount || 0, req.params.id, req.user.id);

    // Save archive data
    if (transcript || versesUsed) {
      const archiveId = uuidv4();
      const session = db.prepare('SELECT * FROM stream_sessions WHERE id = ?').get(req.params.id);
      const duration = session ? Math.round((new Date(session.endedAt || Date.now()) - new Date(session.startedAt)) / 1000) : 0;
      db.prepare(
        `INSERT INTO stream_archives (id, sessionId, transcript, versesUsed, duration, createdAt) VALUES (?,?,?,?,?,datetime('now'))`
      ).run(archiveId, req.params.id, transcript || '', JSON.stringify(versesUsed || []), duration);
    }

    res.json({ message: 'Stream ended' });
  });

  // GET /api/studio/sessions — list sessions (archive)
  router.get('/sessions', (req, res) => {
    const sessions = db.prepare(
      'SELECT s.*, u.firstName, u.lastName FROM stream_sessions s JOIN users u ON s.hostId = u.id ORDER BY s.startedAt DESC LIMIT 50'
    ).all();
    res.json(sessions.map(s => ({ ...s, platforms: JSON.parse(s.platforms || '[]') })));
  });

  // GET /api/studio/sessions/:id — single session with archive
  router.get('/sessions/:id', (req, res) => {
    const session = db.prepare(
      'SELECT s.*, u.firstName, u.lastName FROM stream_sessions s JOIN users u ON s.hostId = u.id WHERE s.id = ?'
    ).get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const archive = db.prepare('SELECT * FROM stream_archives WHERE sessionId = ?').get(req.params.id);
    res.json({
      ...session,
      platforms: JSON.parse(session.platforms || '[]'),
      archive: archive ? { ...archive, versesUsed: JSON.parse(archive.versesUsed || '[]') } : null
    });
  });

  // GET /api/studio/sessions/live — get current live session
  router.get('/live', (req, res) => {
    const live = db.prepare(
      "SELECT s.*, u.firstName, u.lastName FROM stream_sessions s JOIN users u ON s.hostId = u.id WHERE s.status = 'live' ORDER BY s.startedAt DESC LIMIT 1"
    ).get();
    res.json(live ? { ...live, platforms: JSON.parse(live.platforms || '[]') } : null);
  });

  // ==========================================
  // LIVE VIEWER CHAT
  // ==========================================

  // POST /api/studio/sessions/:id/chat
  router.post('/sessions/:id/chat', (req, res) => {
    const { text, type } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const id = uuidv4();
    db.prepare(
      `INSERT INTO stream_chat (id, sessionId, userId, text, type, createdAt) VALUES (?,?,?,?,?,datetime('now'))`
    ).run(id, req.params.id, req.user.id, text, type || 'message');
    res.json({ id });
  });

  // GET /api/studio/sessions/:id/chat
  router.get('/sessions/:id/chat', (req, res) => {
    const messages = db.prepare(
      'SELECT c.*, u.firstName, u.lastName, u.avatar FROM stream_chat c JOIN users u ON c.userId = u.id WHERE c.sessionId = ? ORDER BY c.createdAt DESC LIMIT 100'
    ).all(req.params.id);
    res.json(messages.reverse());
  });

  // POST /api/studio/sessions/:id/react — emoji reaction
  router.post('/sessions/:id/react', (req, res) => {
    const { emoji } = req.body;
    const id = uuidv4();
    db.prepare(
      `INSERT INTO stream_reactions (id, sessionId, userId, emoji, createdAt) VALUES (?,?,?,?,datetime('now'))`
    ).run(id, req.params.id, req.user.id, emoji || '❤️');
    res.json({ id });
  });

  // GET /api/studio/sessions/:id/reactions — get recent reactions
  router.get('/sessions/:id/reactions', (req, res) => {
    const reactions = db.prepare(
      "SELECT emoji, COUNT(*) as count FROM stream_reactions WHERE sessionId = ? AND createdAt > datetime('now', '-30 seconds') GROUP BY emoji"
    ).all(req.params.id);
    res.json(reactions);
  });

  // ==========================================
  // RELAY STATUS
  // ==========================================

  // GET /api/studio/relay-status — get RTMP relay status
  router.get('/relay-status', requireRole('superadmin', 'admin'), (req, res) => {
    try {
      const relayMod = require('../helpers/relay');
      res.json({ active: true, relays: relayMod.getRelayStatus() });
    } catch (e) {
      res.json({ active: false, error: 'Relay module not available' });
    }
  });

  return router;
};
