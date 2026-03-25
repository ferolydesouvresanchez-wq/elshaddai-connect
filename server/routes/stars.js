const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/stars/ranking
  router.get('/ranking', (req, res) => {
    const { period = 'all' } = req.query;
    let dateFilter = '';

    if (period === 'week') {
      dateFilter = "AND s.createdAt >= datetime('now', '-7 days')";
    } else if (period === 'month') {
      dateFilter = "AND s.createdAt >= datetime('now', '-30 days')";
    }

    const ranking = db.prepare(`
      SELECT u.id, u.firstName, u.lastName, u.role, u.avatar,
        COALESCE((SELECT SUM(s.count) FROM stars s WHERE s.toUserId = u.id ${dateFilter}), 0) as totalStars,
        (SELECT COUNT(*) FROM badges WHERE userId = u.id) as badgeCount,
        (SELECT COUNT(*) FROM spaces WHERE hostId = u.id AND status = 'ended') as spacesHosted
      FROM users u WHERE u.active = 1
      ORDER BY totalStars DESC
      LIMIT 50
    `).all();

    res.json(ranking);
  });

  // POST /api/stars - Award stars
  router.post('/', (req, res) => {
    const { toUserId, spaceId, count = 1 } = req.body;
    if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
    if (toUserId === req.user.id) return res.status(400).json({ error: 'Cannot star yourself' });
    if (count < 1 || count > 3) return res.status(400).json({ error: 'Count must be 1-3' });

    db.prepare('INSERT INTO stars (id, spaceId, fromUserId, toUserId, count) VALUES (?, ?, ?, ?, ?)').run(
      uuidv4(), spaceId || null, req.user.id, toUserId, count
    );

    // Check for badge awards
    const totalStars = db.prepare('SELECT COALESCE(SUM(count), 0) as total FROM stars WHERE toUserId = ?').get(toUserId).total;

    const badgeThresholds = [
      { threshold: 10, type: 'rising_star' },
      { threshold: 50, type: 'bright_star' },
      { threshold: 100, type: 'superstar' },
      { threshold: 500, type: 'megastar' }
    ];

    for (const { threshold, type } of badgeThresholds) {
      if (totalStars >= threshold) {
        const hasBadge = db.prepare('SELECT id FROM badges WHERE userId = ? AND type = ?').get(toUserId, type);
        if (!hasBadge) {
          db.prepare('INSERT INTO badges (id, userId, type) VALUES (?, ?, ?)').run(uuidv4(), toUserId, type);

          db.prepare('INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)').run(
            uuidv4(), toUserId, 'badge',
            'New badge!', `You earned the ${type.replace('_', ' ')} badge!`,
            type
          );
        }
      }
    }

    // Notify recipient
    const sender = db.prepare('SELECT firstName, lastName FROM users WHERE id = ?').get(req.user.id);
    db.prepare('INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)').run(
      uuidv4(), toUserId, 'star',
      'Stars received!', `${sender.firstName} ${sender.lastName} gave you ${count} star${count > 1 ? 's' : ''}!`,
      req.user.id
    );

    res.status(201).json({ totalStars, awarded: count });
  });

  // GET /api/stars/user/:userId
  router.get('/user/:userId', (req, res) => {
    const totalStars = db.prepare('SELECT COALESCE(SUM(count), 0) as total FROM stars WHERE toUserId = ?').get(req.params.userId).total;
    const badges = db.prepare('SELECT * FROM badges WHERE userId = ? ORDER BY awardedAt').all(req.params.userId);
    const spacesHosted = db.prepare("SELECT COUNT(*) as count FROM spaces WHERE hostId = ? AND status = 'ended'").get(req.params.userId).count;

    res.json({ totalStars, badges, spacesHosted });
  });

  return router;
};
