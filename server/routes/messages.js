const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/messages/conversations - List user's conversations
  router.get('/conversations', (req, res) => {
    const userId = req.user.id;
    const convIds = db.prepare(
      'SELECT conversationId FROM conversation_participants WHERE userId = ?'
    ).all(userId).map(r => r.conversationId);

    if (convIds.length === 0) return res.json([]);

    const placeholders = convIds.map(() => '?').join(',');
    const conversations = db.prepare(
      `SELECT * FROM conversations WHERE id IN (${placeholders})`
    ).all(...convIds);

    // Enrich with participants and last message
    const result = conversations.map(conv => {
      const participants = db.prepare(
        'SELECT userId FROM conversation_participants WHERE conversationId = ?'
      ).all(conv.id).map(r => r.userId);

      const messages = db.prepare(
        'SELECT * FROM chat_messages WHERE conversationId = ? ORDER BY createdAt ASC'
      ).all(conv.id);

      const chatMessages = messages.map(msg => {
        const readBy = db.prepare(
          'SELECT userId FROM chat_message_reads WHERE messageId = ?'
        ).all(msg.id).map(r => r.userId);
        return { ...msg, readBy };
      });

      return { ...conv, isGroup: conv.isGroup === 1, participants, chatMessages };
    });

    res.json(result);
  });

  // POST /api/messages/conversations - Create conversation
  router.post('/conversations', (req, res) => {
    const { name, participants, isGroup } = req.body;
    const userId = req.user.id;

    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'participants required' });
    }

    // For 1-on-1, check if exists
    if (!isGroup && participants.length === 1) {
      const otherId = participants[0];
      const existing = db.prepare(`
        SELECT cp1.conversationId FROM conversation_participants cp1
        JOIN conversation_participants cp2 ON cp1.conversationId = cp2.conversationId
        JOIN conversations c ON c.id = cp1.conversationId
        WHERE cp1.userId = ? AND cp2.userId = ? AND c.isGroup = 0
      `).get(userId, otherId);
      if (existing) {
        // Return existing conversation
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.conversationId);
        const parts = db.prepare('SELECT userId FROM conversation_participants WHERE conversationId = ?')
          .all(conv.id).map(r => r.userId);
        const messages = db.prepare('SELECT * FROM chat_messages WHERE conversationId = ? ORDER BY createdAt ASC')
          .all(conv.id);
        const chatMessages = messages.map(msg => {
          const readBy = db.prepare('SELECT userId FROM chat_message_reads WHERE messageId = ?')
            .all(msg.id).map(r => r.userId);
          return { ...msg, readBy };
        });
        return res.json({ ...conv, isGroup: false, participants: parts, chatMessages });
      }
    }

    const convId = uuidv4();
    db.prepare('INSERT INTO conversations (id, name, isGroup, createdBy) VALUES (?, ?, ?, ?)')
      .run(convId, name || null, isGroup ? 1 : 0, userId);

    // Add all participants including creator
    const allParticipants = [...new Set([userId, ...participants])];
    const insert = db.prepare('INSERT INTO conversation_participants (id, conversationId, userId) VALUES (?, ?, ?)');
    allParticipants.forEach(pid => insert.run(uuidv4(), convId, pid));

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
    res.status(201).json({ ...conv, isGroup: !!isGroup, participants: allParticipants, chatMessages: [] });
  });

  // POST /api/messages/conversations/:id/messages - Send message
  router.post('/conversations/:id/messages', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    // Verify user is participant
    const participant = db.prepare(
      'SELECT * FROM conversation_participants WHERE conversationId = ? AND userId = ?'
    ).get(req.params.id, req.user.id);
    if (!participant) return res.status(403).json({ error: 'Not a participant' });

    const msgId = uuidv4();
    db.prepare('INSERT INTO chat_messages (id, conversationId, senderId, text) VALUES (?, ?, ?, ?)')
      .run(msgId, req.params.id, req.user.id, text);

    // Mark as read by sender
    db.prepare('INSERT OR IGNORE INTO chat_message_reads (messageId, userId) VALUES (?, ?)')
      .run(msgId, req.user.id);

    const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(msgId);
    res.status(201).json({ ...msg, readBy: [req.user.id] });
  });

  // PUT /api/messages/conversations/:id/read - Mark all messages as read
  router.put('/conversations/:id/read', (req, res) => {
    const unread = db.prepare(`
      SELECT cm.id FROM chat_messages cm
      WHERE cm.conversationId = ? AND cm.senderId != ?
      AND cm.id NOT IN (SELECT messageId FROM chat_message_reads WHERE userId = ?)
    `).all(req.params.id, req.user.id, req.user.id);

    const insert = db.prepare('INSERT OR IGNORE INTO chat_message_reads (messageId, userId) VALUES (?, ?)');
    unread.forEach(m => insert.run(m.id, req.user.id));

    res.json({ marked: unread.length });
  });

  // POST /api/messages/conversations/:id/participants - Add people
  router.post('/conversations/:id/participants', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Make it a group if not already
    db.prepare('UPDATE conversations SET isGroup = 1 WHERE id = ?').run(req.params.id);

    db.prepare('INSERT OR IGNORE INTO conversation_participants (id, conversationId, userId) VALUES (?, ?, ?)')
      .run(uuidv4(), req.params.id, userId);

    res.json({ message: 'Participant added' });
  });

  // DELETE /api/messages/conversations/:id/leave - Leave conversation
  router.delete('/conversations/:id/leave', (req, res) => {
    db.prepare('DELETE FROM conversation_participants WHERE conversationId = ? AND userId = ?')
      .run(req.params.id, req.user.id);
    res.json({ message: 'Left conversation' });
  });

  return router;
};
