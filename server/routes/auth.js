const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { generateToken, authenticate } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();

  // POST /api/auth/login
  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username/email and password required' });
    }

    // Search by username, email, or phone
    const user = db.prepare(
      'SELECT * FROM users WHERE (username = ? OR email = ? OR phone = ?) AND active = 1'
    ).get(username, username, username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.status === 'pending') {
      return res.status(403).json({ error: 'pending', message: 'Your account is pending approval by an administrator.' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ error: 'rejected', message: 'Your account has been rejected. Contact an administrator.' });
    }

    const token = generateToken(user);
    const { password: _, ...userData } = user;
    res.json({ token, user: userData });
  });

  // POST /api/auth/register
  router.post('/register', (req, res) => {
    const { email, phone, password, firstName, lastName, gender, address, birthDate } = req.body;
    if (!password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Required fields: password, firstName, lastName' });
    }
    if (!email && !phone) {
      return res.status(400).json({ error: 'Email or phone is required' });
    }

    // Use email or phone as username
    const username = email || phone;

    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ? OR phone = ?')
      .get(username, email || '', phone || '');
    if (existing) {
      return res.status(409).json({ error: 'Account already exists with this email or phone' });
    }

    const id = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO users (id, username, email, password, firstName, lastName, phone, birthDate, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'member', 'pending')
    `).run(id, username, email || null, hashedPassword, firstName, lastName, phone || null, birthDate || null);

    // Create member record
    const memberId = uuidv4();
    db.prepare(`
      INSERT INTO members (id, userId, firstName, lastName, email, phone, address, birthDate, gender, status, memberSince)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', date('now'))
    `).run(memberId, id, firstName, lastName, email || null, phone || null, address || null, birthDate || null, gender || null);

    res.status(201).json({ pending: true, message: 'Account created. Awaiting administrator approval.' });
  });

  // GET /api/auth/me
  router.get('/me', authenticate, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password: _, ...userData } = user;
    res.json(userData);
  });

  // PUT /api/auth/me
  router.put('/me', authenticate, (req, res) => {
    const { firstName, lastName, email, phone, lang, profileVisibility, avatar } = req.body;
    const updates = [];
    const values = [];

    if (firstName) { updates.push('firstName = ?'); values.push(firstName); }
    if (lastName) { updates.push('lastName = ?'); values.push(lastName); }
    if (email) { updates.push('email = ?'); values.push(email); }
    if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
    if (lang) { updates.push('lang = ?'); values.push(lang); }
    if (profileVisibility) { updates.push('profileVisibility = ?'); values.push(profileVisibility); }
    if (avatar !== undefined) { updates.push('avatar = ?'); values.push(avatar); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push("updatedAt = datetime('now')");
    values.push(req.user.id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const { password: _, ...userData } = user;
    res.json(userData);
  });

  // PUT /api/auth/password
  router.put('/password', authenticate, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashed = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user.id);
    res.json({ message: 'Password updated' });
  });

  return router;
};
