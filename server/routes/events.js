const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/events
  router.get('/', (req, res) => {
    const { upcoming, month, year, type, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT e.*, u.firstName as creatorFirst, u.lastName as creatorLast FROM events e LEFT JOIN users u ON e.createdBy = u.id WHERE 1=1';
    const params = [];

    if (upcoming === 'true') {
      sql += " AND e.date >= date('now')";
    }
    if (month && year) {
      const datePrefix = `${year}-${String(month).padStart(2, '0')}`;
      sql += " AND e.date LIKE ? || '%'";
      params.push(datePrefix);
    }
    if (type) { sql += ' AND e.type = ?'; params.push(type); }

    sql += ' ORDER BY e.date ASC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const events = db.prepare(sql).all(...params);
    res.json(events);
  });

  // GET /api/events/:id
  router.get('/:id', (req, res) => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  });

  // POST /api/events
  router.post('/', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { title, description, date, time, endTime, location, type, recurring } = req.body;
    if (!title || !date) {
      return res.status(400).json({ error: 'Title and date required' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO events (id, title, description, date, time, endTime, location, type, recurring, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description || null, date, time || null, endTime || null,
           location || null, type || 'general', recurring ? 1 : 0, req.user.id);

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    res.status(201).json(event);
  });

  // PUT /api/events/:id
  router.put('/:id', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const { title, description, date, time, endTime, location, type, recurring } = req.body;
    db.prepare(`
      UPDATE events SET title=?, description=?, date=?, time=?, endTime=?, location=?, type=?, recurring=?, updatedAt=datetime('now')
      WHERE id = ?
    `).run(
      title || existing.title, description !== undefined ? description : existing.description,
      date || existing.date, time !== undefined ? time : existing.time,
      endTime !== undefined ? endTime : existing.endTime,
      location !== undefined ? location : existing.location,
      type || existing.type, recurring !== undefined ? (recurring ? 1 : 0) : existing.recurring,
      req.params.id
    );

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    res.json(event);
  });

  // DELETE /api/events/:id
  router.delete('/:id', requireRole('superadmin', 'admin'), (req, res) => {
    db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
    res.json({ message: 'Event deleted' });
  });

  return router;
};
