const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');
const { awardPoints, POINT_VALUES } = require('../helpers/points');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // Helper: enrich post with author, reactions, comments count
  function enrichPost(post) {
    const author = db.prepare('SELECT id, firstName, lastName, role, avatar FROM users WHERE id = ?').get(post.authorId);
    const reactions = db.prepare(`
      SELECT type, COUNT(*) as count FROM reactions WHERE postId = ? GROUP BY type
    `).all(post.id);
    const userReactions = db.prepare('SELECT type FROM reactions WHERE postId = ? AND userId = ?').all(post.id, post._requestUserId);
    const commentCount = db.prepare('SELECT COUNT(*) as count FROM comments WHERE postId = ?').get(post.id).count;

    let repost = null;
    if (post.repostOfId) {
      const original = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.repostOfId);
      if (original) {
        original._requestUserId = post._requestUserId;
        repost = enrichPost(original);
      }
    }

    const { _requestUserId, ...cleanPost } = post;
    return {
      ...cleanPost,
      author,
      reactions: reactions.reduce((acc, r) => { acc[r.type] = r.count; return acc; }, {}),
      userReactions: userReactions.map(r => r.type),
      commentCount,
      repost
    };
  }

  // GET /api/feed
  router.get('/', (req, res) => {
    const { limit = 20, offset = 0, authorId } = req.query;
    let sql = "SELECT * FROM posts WHERE visibility = 'public'";
    const params = [];

    if (authorId) {
      sql = 'SELECT * FROM posts WHERE authorId = ?';
      params.push(authorId);
    }

    sql += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const posts = db.prepare(sql).all(...params);
    const enriched = posts.map(p => { p._requestUserId = req.user.id; return enrichPost(p); });
    res.json(enriched);
  });

  // GET /api/feed/timeline - Posts from followed users
  router.get('/timeline', (req, res) => {
    const { limit = 20, offset = 0 } = req.query;
    const posts = db.prepare(`
      SELECT p.* FROM posts p
      WHERE p.authorId IN (
        SELECT followingId FROM follows WHERE followerId = ? AND status = 'active'
      ) OR p.authorId = ?
      ORDER BY p.createdAt DESC LIMIT ? OFFSET ?
    `).all(req.user.id, req.user.id, Number(limit), Number(offset));

    const enriched = posts.map(p => { p._requestUserId = req.user.id; return enrichPost(p); });
    res.json(enriched);
  });

  // POST /api/feed
  router.post('/', (req, res) => {
    const { text, mediaUrl, mediaType, visibility, groupId, repostOfId } = req.body;
    if (!text && !repostOfId) return res.status(400).json({ error: 'Text or repost required' });
    if (text && text.length > 280) return res.status(400).json({ error: 'Text max 280 characters' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO posts (id, authorId, text, mediaUrl, mediaType, visibility, groupId, repostOfId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, text || null, mediaUrl || null, mediaType || null,
           visibility || 'public', groupId || null, repostOfId || null);

    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    post._requestUserId = req.user.id;

    // Award points: publish_post (+8) or share/repost (+5)
    if (repostOfId) {
      awardPoints(db, req.user.id, 'share', POINT_VALUES.share, id, 'post', null);
    } else {
      awardPoints(db, req.user.id, 'publish_post', POINT_VALUES.publish_post, id, 'post', null);
    }

    res.status(201).json(enrichPost(post));
  });

  // DELETE /api/feed/:id
  router.delete('/:id', (req, res) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.authorId !== req.user.id && !['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
    res.json({ message: 'Post deleted' });
  });

  // POST /api/feed/:id/react
  router.post('/:id/react', (req, res) => {
    const { type } = req.body;
    if (!['like', 'love', 'prayer'].includes(type)) {
      return res.status(400).json({ error: 'Invalid reaction type' });
    }

    const existing = db.prepare('SELECT * FROM reactions WHERE postId = ? AND userId = ? AND type = ?').get(
      req.params.id, req.user.id, type
    );

    if (existing) {
      db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
      res.json({ action: 'removed' });
    } else {
      db.prepare('INSERT INTO reactions (id, postId, userId, type) VALUES (?, ?, ?, ?)').run(
        uuidv4(), req.params.id, req.user.id, type
      );

      // Notify post author
      const post = db.prepare('SELECT authorId FROM posts WHERE id = ?').get(req.params.id);
      if (post && post.authorId !== req.user.id) {
        const user = db.prepare('SELECT firstName, lastName FROM users WHERE id = ?').get(req.user.id);
        db.prepare('INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)').run(
          uuidv4(), post.authorId, 'reaction',
          'New reaction', `${user.firstName} ${user.lastName} reacted ${type} to your post`,
          req.params.id
        );
      }

      // Award like point (+1)
      awardPoints(db, req.user.id, 'like', POINT_VALUES.like, `${req.params.id}_${type}`, 'post', { reactionType: type });

      res.json({ action: 'added' });
    }
  });

  // GET /api/feed/:id/comments
  router.get('/:id/comments', (req, res) => {
    const comments = db.prepare(`
      SELECT c.*, u.firstName, u.lastName, u.role, u.avatar
      FROM comments c JOIN users u ON c.userId = u.id
      WHERE c.postId = ? ORDER BY c.createdAt ASC
    `).all(req.params.id);
    res.json(comments);
  });

  // POST /api/feed/:id/comments
  router.post('/:id/comments', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const id = uuidv4();
    db.prepare('INSERT INTO comments (id, postId, userId, text) VALUES (?, ?, ?, ?)').run(
      id, req.params.id, req.user.id, text
    );

    // Notify post author
    const post = db.prepare('SELECT authorId FROM posts WHERE id = ?').get(req.params.id);
    if (post && post.authorId !== req.user.id) {
      const user = db.prepare('SELECT firstName, lastName FROM users WHERE id = ?').get(req.user.id);
      db.prepare('INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)').run(
        uuidv4(), post.authorId, 'comment',
        'New comment', `${user.firstName} ${user.lastName} commented on your post`,
        req.params.id
      );
    }

    // Award comment points (+3)
    awardPoints(db, req.user.id, 'comment', POINT_VALUES.comment, id, 'post', null);

    const comment = db.prepare(`
      SELECT c.*, u.firstName, u.lastName, u.role, u.avatar
      FROM comments c JOIN users u ON c.userId = u.id WHERE c.id = ?
    `).get(id);
    res.status(201).json(comment);
  });

  return router;
};
