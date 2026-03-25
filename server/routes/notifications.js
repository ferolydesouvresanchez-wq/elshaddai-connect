const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/notifications
  router.get('/', (req, res) => {
    const { limit = 20, unread } = req.query;
    let sql = 'SELECT * FROM notifications WHERE userId = ?';
    const params = [req.user.id];

    if (unread === 'true') {
      sql += ' AND read = 0';
    }

    sql += ' ORDER BY createdAt DESC LIMIT ?';
    params.push(Number(limit));

    const notifications = db.prepare(sql).all(...params);
    const unreadCount = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE userId = ? AND read = 0').get(req.user.id).count;

    res.json({ notifications, unreadCount });
  });

  // PUT /api/notifications/:id/read
  router.put('/:id/read', (req, res) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND userId = ?').run(req.params.id, req.user.id);
    res.json({ message: 'Marked as read' });
  });

  // PUT /api/notifications/read-all
  router.put('/read-all', (req, res) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE userId = ?').run(req.user.id);
    res.json({ message: 'All marked as read' });
  });

  // DELETE /api/notifications/:id
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM notifications WHERE id = ? AND userId = ?').run(req.params.id, req.user.id);
    res.json({ message: 'Deleted' });
  });

  return router;
};
