const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/users - List all users (admin)
  router.get('/', requireRole('superadmin', 'admin'), (req, res) => {
    const users = db.prepare('SELECT id, username, email, firstName, lastName, role, phone, avatar, active, createdAt FROM users ORDER BY lastName').all();
    res.json(users);
  });

  // GET /api/users/:id - Get user profile
  router.get('/:id', (req, res) => {
    const user = db.prepare('SELECT id, firstName, lastName, role, avatar, profileVisibility, createdAt FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const followerCount = db.prepare("SELECT COUNT(*) as count FROM follows WHERE followingId = ? AND status = 'active'").get(req.params.id).count;
    const followingCount = db.prepare("SELECT COUNT(*) as count FROM follows WHERE followerId = ? AND status = 'active'").get(req.params.id).count;
    const totalStars = db.prepare('SELECT COALESCE(SUM(count), 0) as total FROM stars WHERE toUserId = ?').get(req.params.id).total;
    const badges = db.prepare('SELECT * FROM badges WHERE userId = ?').all(req.params.id);

    res.json({ ...user, followerCount, followingCount, totalStars, badges });
  });

  // POST /api/users - Create user (admin)
  router.post('/', requireRole('superadmin', 'admin'), (req, res) => {
    const { username, email, password, firstName, lastName, role, phone } = req.body;
    if (!username || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'username, password, firstName, lastName required' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username exists' });

    const id = uuidv4();
    const hashed = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO users (id, username, email, password, firstName, lastName, role, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, username, email || null, hashed, firstName, lastName, role || 'member', phone || null);

    // Create member record
    db.prepare(`
      INSERT INTO members (id, userId, firstName, lastName, email, status, memberSince)
      VALUES (?, ?, ?, ?, ?, 'active', date('now'))
    `).run(uuidv4(), id, firstName, lastName, email || null);

    const user = db.prepare('SELECT id, username, email, firstName, lastName, role, phone, active, createdAt FROM users WHERE id = ?').get(id);
    res.status(201).json(user);
  });

  // PUT /api/users/:id - Update user (admin)
  router.put('/:id', requireRole('superadmin', 'admin'), (req, res) => {
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const { firstName, lastName, email, role, phone, active } = req.body;
    db.prepare(`
      UPDATE users SET firstName=?, lastName=?, email=?, role=?, phone=?, active=?, updatedAt=datetime('now')
      WHERE id = ?
    `).run(
      firstName || existing.firstName, lastName || existing.lastName,
      email !== undefined ? email : existing.email,
      role || existing.role, phone !== undefined ? phone : existing.phone,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );

    const user = db.prepare('SELECT id, username, email, firstName, lastName, role, phone, active, createdAt FROM users WHERE id = ?').get(req.params.id);
    res.json(user);
  });

  // PUT /api/users/:id/reset-password (admin)
  router.put('/:id/reset-password', requireRole('superadmin'), (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'newPassword required' });

    const hashed = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.params.id);
    res.json({ message: 'Password reset' });
  });

  // DELETE /api/users/:id (soft delete - deactivate)
  router.delete('/:id', requireRole('superadmin'), (req, res) => {
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
    res.json({ message: 'User deactivated' });
  });

  return router;
};
