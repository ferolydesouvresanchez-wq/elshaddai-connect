const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/groups
  router.get('/', (req, res) => {
    const groups = db.prepare(`
      SELECT g.*, u.firstName as leaderFirst, u.lastName as leaderLast,
        (SELECT COUNT(*) FROM group_members WHERE groupId = g.id) as memberCount
      FROM groups_table g LEFT JOIN users u ON g.leaderId = u.id
      ORDER BY g.name
    `).all();
    res.json(groups);
  });

  // GET /api/groups/:id
  router.get('/:id', (req, res) => {
    const group = db.prepare(`
      SELECT g.*, u.firstName as leaderFirst, u.lastName as leaderLast
      FROM groups_table g LEFT JOIN users u ON g.leaderId = u.id WHERE g.id = ?
    `).get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const members = db.prepare(`
      SELECT gm.*, m.firstName, m.lastName, m.email
      FROM group_members gm JOIN members m ON gm.memberId = m.id
      WHERE gm.groupId = ?
    `).all(req.params.id);

    const courses = db.prepare('SELECT * FROM courses WHERE groupId = ? ORDER BY sortOrder').all(req.params.id);

    res.json({ ...group, members, courses });
  });

  // POST /api/groups
  router.post('/', requireRole('superadmin', 'admin'), (req, res) => {
    const { name, description, type, leaderId, meetingDay, meetingTime } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO groups_table (id, name, description, type, leaderId, meetingDay, meetingTime)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description || null, type || 'ministry', leaderId || null,
           meetingDay || null, meetingTime || null);

    const group = db.prepare('SELECT * FROM groups_table WHERE id = ?').get(id);
    res.status(201).json(group);
  });

  // PUT /api/groups/:id
  router.put('/:id', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const existing = db.prepare('SELECT * FROM groups_table WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Group not found' });

    const { name, description, type, leaderId, meetingDay, meetingTime, active } = req.body;
    db.prepare(`
      UPDATE groups_table SET name=?, description=?, type=?, leaderId=?, meetingDay=?, meetingTime=?, active=?, updatedAt=datetime('now')
      WHERE id = ?
    `).run(
      name || existing.name, description !== undefined ? description : existing.description,
      type || existing.type, leaderId !== undefined ? leaderId : existing.leaderId,
      meetingDay !== undefined ? meetingDay : existing.meetingDay,
      meetingTime !== undefined ? meetingTime : existing.meetingTime,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );

    const group = db.prepare('SELECT * FROM groups_table WHERE id = ?').get(req.params.id);
    res.json(group);
  });

  // DELETE /api/groups/:id
  router.delete('/:id', requireRole('superadmin', 'admin'), (req, res) => {
    db.prepare('DELETE FROM groups_table WHERE id = ?').run(req.params.id);
    res.json({ message: 'Group deleted' });
  });

  // POST /api/groups/:id/members - Add member to group
  router.post('/:id/members', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { memberId, role } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId required' });

    const id = uuidv4();
    try {
      db.prepare('INSERT INTO group_members (id, groupId, memberId, role) VALUES (?, ?, ?, ?)').run(
        id, req.params.id, memberId, role || 'member'
      );
      res.status(201).json({ message: 'Member added to group' });
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Member already in group' });
      }
      throw e;
    }
  });

  // DELETE /api/groups/:groupId/members/:memberId
  router.delete('/:groupId/members/:memberId', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    db.prepare('DELETE FROM group_members WHERE groupId = ? AND memberId = ?').run(
      req.params.groupId, req.params.memberId
    );
    res.json({ message: 'Member removed from group' });
  });

  return router;
};
