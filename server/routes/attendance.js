const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/attendance - Get attendance records
  router.get('/', (req, res) => {
    const { date, memberId, eventType, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT a.*, m.firstName, m.lastName FROM attendance a
               JOIN members m ON a.memberId = m.id WHERE 1=1`;
    const params = [];

    if (date) { sql += ' AND a.date = ?'; params.push(date); }
    if (memberId) { sql += ' AND a.memberId = ?'; params.push(memberId); }
    if (eventType) { sql += ' AND a.eventType = ?'; params.push(eventType); }

    sql += ' ORDER BY a.date DESC, m.lastName LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const records = db.prepare(sql).all(...params);
    res.json(records);
  });

  // GET /api/attendance/stats
  router.get('/stats', (req, res) => {
    const { month, year } = req.query;
    const y = year || new Date().getFullYear();
    const m = month || (new Date().getMonth() + 1);
    const datePrefix = `${y}-${String(m).padStart(2, '0')}`;

    const totalMembers = db.prepare('SELECT COUNT(*) as count FROM members WHERE status = ?').get('active').count;
    const datesThisMonth = db.prepare(
      "SELECT DISTINCT date FROM attendance WHERE date LIKE ? || '%'"
    ).all(datePrefix).map(r => r.date);

    const stats = datesThisMonth.map(date => {
      const present = db.prepare('SELECT COUNT(*) as count FROM attendance WHERE date = ? AND present = 1').get(date).count;
      return { date, present, total: totalMembers, rate: totalMembers > 0 ? Math.round((present / totalMembers) * 100) : 0 };
    });

    res.json({ totalMembers, month: m, year: y, stats });
  });

  // POST /api/attendance - Record attendance (batch)
  router.post('/', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { date, eventType = 'sunday_service', records } = req.body;
    if (!date || !records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'date and records[] required' });
    }

    const insert = db.prepare(`
      INSERT OR REPLACE INTO attendance (id, memberId, date, eventType, present, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((recs) => {
      for (const rec of recs) {
        // Check if record exists
        const existing = db.prepare(
          'SELECT id FROM attendance WHERE memberId = ? AND date = ? AND eventType = ?'
        ).get(rec.memberId, date, eventType);

        insert.run(
          existing ? existing.id : uuidv4(),
          rec.memberId, date, eventType,
          rec.present ? 1 : 0, rec.notes || null
        );
      }
    });

    insertMany(records);
    res.status(201).json({ message: `${records.length} attendance records saved` });
  });

  // DELETE /api/attendance/:id
  router.delete('/:id', requireRole('superadmin', 'admin'), (req, res) => {
    db.prepare('DELETE FROM attendance WHERE id = ?').run(req.params.id);
    res.json({ message: 'Record deleted' });
  });

  return router;
};
