const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  function enrichSpace(space) {
    const host = db.prepare('SELECT id, firstName, lastName, role, avatar FROM users WHERE id = ?').get(space.hostId);
    const participantCount = db.prepare("SELECT COUNT(*) as count FROM space_participants WHERE spaceId = ? AND leftAt IS NULL").get(space.id).count;
    return { ...space, host, participantCount };
  }

  // GET /api/spaces
  router.get('/', (req, res) => {
    const { status } = req.query;
    let sql = 'SELECT * FROM spaces';
    const params = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    sql += " ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, scheduledAt ASC";
    const spaces = db.prepare(sql).all(...params);
    res.json(spaces.map(enrichSpace));
  });

  // GET /api/spaces/:id
  router.get('/:id', (req, res) => {
    const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
    if (!space) return res.status(404).json({ error: 'Space not found' });

    const participants = db.prepare(`
      SELECT sp.*, u.firstName, u.lastName, u.role, u.avatar
      FROM space_participants sp JOIN users u ON sp.userId = u.id
      WHERE sp.spaceId = ? AND sp.leftAt IS NULL
    `).all(req.params.id);

    const chats = db.prepare(`
      SELECT sc.*, u.firstName, u.lastName, u.avatar
      FROM space_chats sc JOIN users u ON sc.userId = u.id
      WHERE sc.spaceId = ? ORDER BY sc.createdAt ASC
    `).all(req.params.id);

    res.json({ ...enrichSpace(space), participants, chats });
  });

  // POST /api/spaces
  router.post('/', (req, res) => {
    const { title, description, type, scheduledAt } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO spaces (id, hostId, title, description, type, status, scheduledAt)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?)
    `).run(id, req.user.id, title, description || null, type || 'audio', scheduledAt || null);

    const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
    res.status(201).json(enrichSpace(space));
  });

  // PUT /api/spaces/:id/live - Go live
  router.put('/:id/live', (req, res) => {
    const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
    if (!space) return res.status(404).json({ error: 'Space not found' });
    if (space.hostId !== req.user.id && !['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only host can go live' });
    }

    db.prepare("UPDATE spaces SET status = 'live', startedAt = datetime('now') WHERE id = ?").run(req.params.id);

    // Notify followers
    const followers = db.prepare(`
      SELECT followerId FROM follows WHERE followingId = ? AND status = 'active'
    `).all(req.user.id);

    const host = db.prepare('SELECT firstName, lastName FROM users WHERE id = ?').get(req.user.id);
    for (const f of followers) {
      db.prepare('INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)').run(
        uuidv4(), f.followerId, 'space_live',
        'Space is live!', `${host.firstName} ${host.lastName} is now live: ${space.title}`,
        req.params.id
      );
    }

    const updated = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
    res.json(enrichSpace(updated));
  });

  // PUT /api/spaces/:id/end - End space
  router.put('/:id/end', (req, res) => {
    const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
    if (!space) return res.status(404).json({ error: 'Space not found' });
    if (space.hostId !== req.user.id && !['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only host can end' });
    }

    db.prepare("UPDATE spaces SET status = 'ended', endedAt = datetime('now') WHERE id = ?").run(req.params.id);
    db.prepare("UPDATE space_participants SET leftAt = datetime('now') WHERE spaceId = ? AND leftAt IS NULL").run(req.params.id);

    const updated = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
    res.json(enrichSpace(updated));
  });

  // POST /api/spaces/:id/join
  router.post('/:id/join', (req, res) => {
    const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
    if (!space) return res.status(404).json({ error: 'Space not found' });

    const existing = db.prepare('SELECT * FROM space_participants WHERE spaceId = ? AND userId = ? AND leftAt IS NULL').get(
      req.params.id, req.user.id
    );
    if (existing) return res.json({ message: 'Already in space' });

    db.prepare('INSERT INTO space_participants (id, spaceId, userId) VALUES (?, ?, ?)').run(
      uuidv4(), req.params.id, req.user.id
    );
    res.status(201).json({ message: 'Joined space' });
  });

  // POST /api/spaces/:id/leave
  router.post('/:id/leave', (req, res) => {
    db.prepare("UPDATE space_participants SET leftAt = datetime('now') WHERE spaceId = ? AND userId = ? AND leftAt IS NULL").run(
      req.params.id, req.user.id
    );
    res.json({ message: 'Left space' });
  });

  // POST /api/spaces/:id/chat
  router.post('/:id/chat', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const id = uuidv4();
    db.prepare('INSERT INTO space_chats (id, spaceId, userId, text) VALUES (?, ?, ?, ?)').run(
      id, req.params.id, req.user.id, text
    );

    const chat = db.prepare(`
      SELECT sc.*, u.firstName, u.lastName, u.avatar
      FROM space_chats sc JOIN users u ON sc.userId = u.id WHERE sc.id = ?
    `).get(id);
    res.status(201).json(chat);
  });

  // DELETE /api/spaces/:id
  router.delete('/:id', (req, res) => {
    const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(req.params.id);
    if (!space) return res.status(404).json({ error: 'Space not found' });
    if (space.hostId !== req.user.id && !['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    db.prepare('DELETE FROM spaces WHERE id = ?').run(req.params.id);
    res.json({ message: 'Space deleted' });
  });

  return router;
};
