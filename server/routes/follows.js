const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');
const { awardPoints, POINT_VALUES } = require('../helpers/points');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // GET /api/follows/followers - My followers
  router.get('/followers', (req, res) => {
    const followers = db.prepare(`
      SELECT f.*, u.id as userId, u.firstName, u.lastName, u.role, u.avatar
      FROM follows f JOIN users u ON f.followerId = u.id
      WHERE f.followingId = ? AND f.status = 'active'
    `).all(req.user.id);
    res.json(followers);
  });

  // GET /api/follows/following - Who I follow
  router.get('/following', (req, res) => {
    const following = db.prepare(`
      SELECT f.*, u.id as userId, u.firstName, u.lastName, u.role, u.avatar
      FROM follows f JOIN users u ON f.followingId = u.id
      WHERE f.followerId = ? AND f.status = 'active'
    `).all(req.user.id);
    res.json(following);
  });

  // GET /api/follows/pending - Pending follow requests to me
  router.get('/pending', (req, res) => {
    const pending = db.prepare(`
      SELECT f.*, u.id as userId, u.firstName, u.lastName, u.role, u.avatar
      FROM follows f JOIN users u ON f.followerId = u.id
      WHERE f.followingId = ? AND f.status = 'pending'
    `).all(req.user.id);
    res.json(pending);
  });

  // GET /api/follows/status/:userId - Check follow status with a user
  router.get('/status/:userId', (req, res) => {
    const follow = db.prepare('SELECT * FROM follows WHERE followerId = ? AND followingId = ?').get(
      req.user.id, req.params.userId
    );
    res.json({ status: follow ? follow.status : 'none' });
  });

  // POST /api/follows/:userId - Follow a user
  router.post('/:userId', (req, res) => {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const existing = db.prepare('SELECT * FROM follows WHERE followerId = ? AND followingId = ?').get(
      req.user.id, req.params.userId
    );
    if (existing) {
      return res.status(409).json({ error: 'Already following or requested', status: existing.status });
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const status = target.profileVisibility === 'private' ? 'pending' : 'active';
    db.prepare('INSERT INTO follows (id, followerId, followingId, status) VALUES (?, ?, ?, ?)').run(
      uuidv4(), req.user.id, req.params.userId, status
    );

    // Notify target user
    const follower = db.prepare('SELECT firstName, lastName FROM users WHERE id = ?').get(req.user.id);
    db.prepare('INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)').run(
      uuidv4(), req.params.userId,
      status === 'pending' ? 'follow_request' : 'new_follower',
      status === 'pending' ? 'Follow request' : 'New follower',
      `${follower.firstName} ${follower.lastName} ${status === 'pending' ? 'wants to follow you' : 'is now following you'}`,
      req.user.id
    );

    // Award follow points: +2 for following, +3 for being followed (if active immediately)
    if (status === 'active') {
      awardPoints(db, req.user.id, 'follow', POINT_VALUES.follow, req.params.userId, 'user', null);
      awardPoints(db, req.params.userId, 'followed', POINT_VALUES.followed, req.user.id, 'user', null);
    }

    res.status(201).json({ status });
  });

  // PUT /api/follows/:followId/accept - Accept follow request
  router.put('/:followId/accept', (req, res) => {
    const follow = db.prepare('SELECT * FROM follows WHERE id = ? AND followingId = ?').get(
      req.params.followId, req.user.id
    );
    if (!follow) return res.status(404).json({ error: 'Follow request not found' });

    db.prepare("UPDATE follows SET status = 'active' WHERE id = ?").run(req.params.followId);

    // Award follow/followed points on acceptance
    awardPoints(db, follow.followerId, 'follow', POINT_VALUES.follow, req.user.id, 'user', null);
    awardPoints(db, req.user.id, 'followed', POINT_VALUES.followed, follow.followerId, 'user', null);

    // Notify the follower
    const user = db.prepare('SELECT firstName, lastName FROM users WHERE id = ?').get(req.user.id);
    db.prepare('INSERT INTO notifications (id, userId, type, title, message, refId) VALUES (?, ?, ?, ?, ?, ?)').run(
      uuidv4(), follow.followerId, 'follow_accepted',
      'Follow accepted', `${user.firstName} ${user.lastName} accepted your follow request`,
      req.user.id
    );

    res.json({ status: 'active' });
  });

  // PUT /api/follows/:followId/reject - Reject follow request
  router.put('/:followId/reject', (req, res) => {
    db.prepare("UPDATE follows SET status = 'rejected' WHERE id = ? AND followingId = ?").run(
      req.params.followId, req.user.id
    );
    res.json({ status: 'rejected' });
  });

  // DELETE /api/follows/:userId - Unfollow
  router.delete('/:userId', (req, res) => {
    db.prepare('DELETE FROM follows WHERE followerId = ? AND followingId = ?').run(
      req.user.id, req.params.userId
    );
    res.json({ message: 'Unfollowed' });
  });

  // GET /api/follows/discover - Discover users to follow
  router.get('/discover', (req, res) => {
    const users = db.prepare(`
      SELECT id, firstName, lastName, role, avatar FROM users
      WHERE id != ? AND active = 1
      AND id NOT IN (SELECT followingId FROM follows WHERE followerId = ?)
      LIMIT 20
    `).all(req.user.id, req.user.id);
    res.json(users);
  });

  return router;
};
