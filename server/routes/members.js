const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/members
  router.get('/', (req, res) => {
    const { status, search, limit = 50, offset = 0 } = req.query;
    let sql = 'SELECT * FROM members WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (search) {
      sql += ' AND (firstName LIKE ? OR lastName LIKE ? OR email LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
    const total = db.prepare(countSql).get(...params).total;

    sql += ' ORDER BY lastName, firstName LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    const members = db.prepare(sql).all(...params);

    res.json({ members, total, limit: Number(limit), offset: Number(offset) });
  });

  // GET /api/members/:id
  router.get('/:id', (req, res) => {
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    res.json(member);
  });

  // POST /api/members
  router.post('/', requireRole('superadmin', 'admin'), (req, res) => {
    const { firstName, lastName, email, phone, address, birthDate, gender, memberSince, notes } = req.body;
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'First and last name required' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO members (id, firstName, lastName, email, phone, address, birthDate, gender, memberSince, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, firstName, lastName, email || null, phone || null, address || null,
           birthDate || null, gender || null, memberSince || null, notes || null);

    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    res.status(201).json(member);
  });

  // PUT /api/members/:id
  router.put('/:id', requireRole('superadmin', 'admin'), (req, res) => {
    const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Member not found' });

    const { firstName, lastName, email, phone, address, birthDate, gender, memberSince, status, notes } = req.body;
    db.prepare(`
      UPDATE members SET firstName=?, lastName=?, email=?, phone=?, address=?, birthDate=?, gender=?, memberSince=?, status=?, notes=?, updatedAt=datetime('now')
      WHERE id = ?
    `).run(
      firstName || existing.firstName, lastName || existing.lastName,
      email !== undefined ? email : existing.email, phone !== undefined ? phone : existing.phone,
      address !== undefined ? address : existing.address, birthDate || existing.birthDate,
      gender || existing.gender, memberSince || existing.memberSince,
      status || existing.status, notes !== undefined ? notes : existing.notes,
      req.params.id
    );

    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    res.json(member);
  });

  // DELETE /api/members/:id
  router.delete('/:id', requireRole('superadmin', 'admin'), (req, res) => {
    const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Member not found' });

    db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
    res.json({ message: 'Member deleted' });
  });

  return router;
};
