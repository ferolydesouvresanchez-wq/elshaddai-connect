const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');
const { POINT_VALUES, TIERS, getTierForPoints, getNextTier, awardPoints, ensureUserPoints, processMissedEvents } = require('../helpers/points');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // =============================================================
  // GET /api/ranking/leaderboard - Public leaderboard
  // =============================================================
  router.get('/leaderboard', (req, res) => {
    const { period = 'all', limit = 50, groupId } = req.query;

    let leaderboard;
    if (period === 'all') {
      // Use materialized totals from user_points
      leaderboard = db.prepare(`
        SELECT up.userId, up.totalPoints, up.currentTier, up.loginStreak, up.bestLoginStreak,
               u.firstName, u.lastName, u.role, u.avatar,
               (SELECT pl.actionType FROM point_ledger pl WHERE pl.userId = up.userId ORDER BY pl.createdAt DESC LIMIT 1) as lastAction,
               (SELECT pl.createdAt FROM point_ledger pl WHERE pl.userId = up.userId ORDER BY pl.createdAt DESC LIMIT 1) as lastActionAt
        FROM user_points up
        JOIN users u ON up.userId = u.id
        WHERE u.active = 1
        ORDER BY up.totalPoints DESC
        LIMIT ?
      `).all(Number(limit));
    } else {
      // Calculate from ledger for time-filtered periods
      let dateFilter = '';
      if (period === 'week') dateFilter = "AND pl.createdAt >= datetime('now', '-7 days')";
      else if (period === 'month') dateFilter = "AND pl.createdAt >= datetime('now', '-30 days')";

      leaderboard = db.prepare(`
        SELECT u.id as userId, u.firstName, u.lastName, u.role, u.avatar,
               COALESCE(SUM(pl.points), 0) as totalPoints,
               up.currentTier, up.loginStreak, up.bestLoginStreak,
               (SELECT pl2.actionType FROM point_ledger pl2 WHERE pl2.userId = u.id ORDER BY pl2.createdAt DESC LIMIT 1) as lastAction,
               (SELECT pl2.createdAt FROM point_ledger pl2 WHERE pl2.userId = u.id ORDER BY pl2.createdAt DESC LIMIT 1) as lastActionAt
        FROM users u
        LEFT JOIN point_ledger pl ON pl.userId = u.id ${dateFilter}
        LEFT JOIN user_points up ON up.userId = u.id
        WHERE u.active = 1
        GROUP BY u.id
        HAVING totalPoints > 0
        ORDER BY totalPoints DESC
        LIMIT ?
      `).all(Number(limit));
    }

    // Add rank numbers and tier info
    const enriched = leaderboard.map((entry, idx) => {
      const tier = getTierForPoints(period === 'all' ? entry.totalPoints : (db.prepare('SELECT totalPoints FROM user_points WHERE userId = ?').get(entry.userId)?.totalPoints || 0));
      return {
        ...entry,
        rank: idx + 1,
        tier: tier,
      };
    });

    // Always include current user's rank
    const myUserId = req.user.id;
    const myEntry = enriched.find(e => e.userId === myUserId);
    let myRank = null;
    if (!myEntry) {
      ensureUserPoints(db, myUserId);
      const myPoints = db.prepare('SELECT totalPoints, currentTier, loginStreak, bestLoginStreak FROM user_points WHERE userId = ?').get(myUserId);
      const myUser = db.prepare('SELECT firstName, lastName, role, avatar FROM users WHERE id = ?').get(myUserId);

      let periodPoints = myPoints.totalPoints;
      if (period !== 'all') {
        let dateFilter = '';
        if (period === 'week') dateFilter = "AND createdAt >= datetime('now', '-7 days')";
        else if (period === 'month') dateFilter = "AND createdAt >= datetime('now', '-30 days')";
        periodPoints = db.prepare(`SELECT COALESCE(SUM(points), 0) as total FROM point_ledger WHERE userId = ? ${dateFilter}`).get(myUserId).total;
      }

      // Calculate rank position
      const aboveCount = period === 'all'
        ? db.prepare('SELECT COUNT(*) as c FROM user_points WHERE totalPoints > ?').get(myPoints.totalPoints).c
        : db.prepare(`SELECT COUNT(DISTINCT userId) as c FROM (SELECT userId, SUM(points) as total FROM point_ledger WHERE 1=1 ${period === 'week' ? "AND createdAt >= datetime('now', '-7 days')" : period === 'month' ? "AND createdAt >= datetime('now', '-30 days')" : ''} GROUP BY userId HAVING total > ?)`)
            .get(periodPoints).c;

      myRank = {
        userId: myUserId,
        firstName: myUser.firstName,
        lastName: myUser.lastName,
        role: myUser.role,
        avatar: myUser.avatar,
        totalPoints: periodPoints,
        currentTier: myPoints.currentTier,
        loginStreak: myPoints.loginStreak,
        bestLoginStreak: myPoints.bestLoginStreak,
        rank: aboveCount + 1,
        tier: getTierForPoints(myPoints.totalPoints),
      };
    }

    res.json({ leaderboard: enriched, myRank, tiers: TIERS, pointValues: POINT_VALUES });
  });

  // =============================================================
  // GET /api/ranking/me - Personal rank dashboard
  // =============================================================
  router.get('/me', (req, res) => {
    const userId = req.user.id;
    ensureUserPoints(db, userId);

    const points = db.prepare('SELECT * FROM user_points WHERE userId = ?').get(userId);
    const tier = getTierForPoints(points.totalPoints);
    const nextTier = getNextTier(tier.name);

    // Activity history (last 50 entries)
    const history = db.prepare(`
      SELECT id, actionType, points, relatedEntityId, relatedEntityType, metadata, createdAt
      FROM point_ledger WHERE userId = ? ORDER BY createdAt DESC LIMIT 50
    `).all(userId);

    // Attendance breakdown
    const onTimeCount = db.prepare("SELECT COUNT(*) as c FROM point_ledger WHERE userId = ? AND actionType = 'checkin_ontime'").get(userId).c;
    const lateCount = db.prepare("SELECT COUNT(*) as c FROM point_ledger WHERE userId = ? AND actionType = 'checkin_late'").get(userId).c;
    const veryLateCount = db.prepare("SELECT COUNT(*) as c FROM point_ledger WHERE userId = ? AND actionType = 'checkin_verylate'").get(userId).c;
    const walkinCount = db.prepare("SELECT COUNT(*) as c FROM point_ledger WHERE userId = ? AND actionType = 'walkin_checkin'").get(userId).c;
    const missedCount = db.prepare("SELECT COUNT(*) as c FROM point_ledger WHERE userId = ? AND actionType = 'missed_event'").get(userId).c;
    const checkoutCount = db.prepare("SELECT COUNT(*) as c FROM point_ledger WHERE userId = ? AND actionType = 'checkout'").get(userId).c;
    const fullAttendCount = db.prepare("SELECT COUNT(*) as c FROM point_ledger WHERE userId = ? AND actionType = 'full_attendance'").get(userId).c;

    // Personal stats
    const totalEventsAttended = onTimeCount + lateCount + veryLateCount + walkinCount;
    const totalPosts = db.prepare('SELECT COUNT(*) as c FROM posts WHERE authorId = ?').get(userId).c;
    const totalGroups = db.prepare(`
      SELECT COUNT(*) as c FROM group_members gm JOIN members m ON gm.memberId = m.id WHERE m.userId = ?
    `).get(userId).c;
    const totalFollowers = db.prepare("SELECT COUNT(*) as c FROM follows WHERE followingId = ? AND status = 'active'").get(userId).c;
    const totalFollowing = db.prepare("SELECT COUNT(*) as c FROM follows WHERE followerId = ? AND status = 'active'").get(userId).c;

    // Average member score
    const avgScore = db.prepare('SELECT AVG(totalPoints) as avg FROM user_points').get().avg || 0;

    // Rank position
    const rank = db.prepare('SELECT COUNT(*) as c FROM user_points WHERE totalPoints > ?').get(points.totalPoints).c + 1;
    const totalMembers = db.prepare('SELECT COUNT(*) as c FROM user_points').get().c;

    res.json({
      totalPoints: points.totalPoints,
      currentTier: tier,
      nextTier,
      pointsToNextTier: nextTier ? nextTier.min - points.totalPoints : 0,
      progressPercent: nextTier ? Math.min(100, Math.round(((points.totalPoints - tier.min) / (nextTier.min - tier.min)) * 100)) : 100,
      loginStreak: points.loginStreak,
      bestLoginStreak: points.bestLoginStreak,
      rank,
      totalMembers,
      history,
      attendance: { onTime: onTimeCount, late: lateCount, veryLate: veryLateCount, walkin: walkinCount, missed: missedCount, checkouts: checkoutCount, fullAttendance: fullAttendCount },
      stats: { eventsAttended: totalEventsAttended, posts: totalPosts, groups: totalGroups, followers: totalFollowers, following: totalFollowing },
      averageScore: Math.round(avgScore),
      tiers: TIERS,
    });
  });

  // =============================================================
  // GET /api/ranking/user/:userId - View another user's public rank
  // =============================================================
  router.get('/user/:userId', (req, res) => {
    ensureUserPoints(db, req.params.userId);
    const points = db.prepare('SELECT * FROM user_points WHERE userId = ?').get(req.params.userId);
    const tier = getTierForPoints(points.totalPoints);
    const rank = db.prepare('SELECT COUNT(*) as c FROM user_points WHERE totalPoints > ?').get(points.totalPoints).c + 1;

    res.json({
      totalPoints: points.totalPoints,
      currentTier: tier,
      loginStreak: points.loginStreak,
      rank,
    });
  });

  // =============================================================
  // ADMIN ENDPOINTS
  // =============================================================

  // GET /api/ranking/admin/members - Full admin member list with ranking data
  router.get('/admin/members', requireRole('superadmin', 'admin'), (req, res) => {
    const { tier, sortBy = 'points', order = 'desc' } = req.query;

    let sql = `
      SELECT up.userId, up.totalPoints, up.currentTier, up.loginStreak, up.bestLoginStreak, up.lastLoginDate, up.updatedAt,
             u.firstName, u.lastName, u.role, u.avatar, u.email, u.phone,
             (SELECT COUNT(*) FROM point_ledger pl WHERE pl.userId = up.userId AND pl.actionType = 'missed_event') as missedEvents,
             (SELECT MAX(pl.createdAt) FROM point_ledger pl WHERE pl.userId = up.userId) as lastActivity
      FROM user_points up
      JOIN users u ON up.userId = u.id
      WHERE u.active = 1
    `;
    const params = [];
    if (tier) { sql += ' AND up.currentTier = ?'; params.push(tier); }

    const orderCol = sortBy === 'name' ? 'u.firstName' : sortBy === 'streak' ? 'up.loginStreak' : 'up.totalPoints';
    sql += ` ORDER BY ${orderCol} ${order === 'asc' ? 'ASC' : 'DESC'}`;

    const members = db.prepare(sql).all(...params);

    // Identify inactive (no activity in 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString();

    const enriched = members.map((m, idx) => ({
      ...m,
      rank: idx + 1,
      tier: getTierForPoints(m.totalPoints),
      inactive: !m.lastActivity || m.lastActivity < cutoff,
      flagMissed: m.missedEvents >= 3,
    }));

    res.json(enriched);
  });

  // POST /api/ranking/admin/adjust - Manual point adjustment
  router.post('/admin/adjust', requireRole('superadmin', 'admin'), (req, res) => {
    const { userId, points, reason } = req.body;
    if (!userId || points === undefined || !reason) {
      return res.status(400).json({ error: 'userId, points, and reason required' });
    }

    const target = db.prepare('SELECT id, firstName, lastName FROM users WHERE id = ?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const adjustId = uuidv4();
    const result = awardPoints(db, userId, 'admin_adjust', Number(points), adjustId, 'admin', {
      note: reason,
      adminId: req.user.id,
      adminName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
    });

    res.json({
      message: `${Number(points) >= 0 ? 'Awarded' : 'Deducted'} ${Math.abs(Number(points))} points ${Number(points) >= 0 ? 'to' : 'from'} ${target.firstName} ${target.lastName}`,
      newTotal: result.newTotal,
      tierChanged: result.tierChanged,
      newTier: result.newTier,
    });
  });

  // GET /api/ranking/admin/adjustments - View all manual adjustments
  router.get('/admin/adjustments', requireRole('superadmin', 'admin'), (req, res) => {
    const adjustments = db.prepare(`
      SELECT pl.*, u.firstName, u.lastName
      FROM point_ledger pl
      JOIN users u ON pl.userId = u.id
      WHERE pl.actionType = 'admin_adjust'
      ORDER BY pl.createdAt DESC LIMIT 100
    `).all();

    res.json(adjustments.map(a => ({
      ...a,
      metadata: a.metadata ? JSON.parse(a.metadata) : null,
    })));
  });

  // GET /api/ranking/admin/export - Export full ranking report as JSON
  router.get('/admin/export', requireRole('superadmin', 'admin'), (req, res) => {
    const members = db.prepare(`
      SELECT up.*, u.firstName, u.lastName, u.email, u.role
      FROM user_points up JOIN users u ON up.userId = u.id
      ORDER BY up.totalPoints DESC
    `).all();

    const report = members.map((m, idx) => ({
      rank: idx + 1,
      name: `${m.firstName} ${m.lastName}`,
      email: m.email,
      role: m.role,
      totalPoints: m.totalPoints,
      tier: getTierForPoints(m.totalPoints).label,
      loginStreak: m.loginStreak,
      bestLoginStreak: m.bestLoginStreak,
      lastLoginDate: m.lastLoginDate,
    }));

    res.json(report);
  });

  // =============================================================
  // POST /api/ranking/process-missed - Trigger missed event processing
  // =============================================================
  router.post('/process-missed', requireRole('superadmin', 'admin'), (req, res) => {
    const result = processMissedEvents(db);
    res.json({ message: 'Processed missed events', ...result });
  });

  // =============================================================
  // GET /api/ranking/tiers - Get tier definitions
  // =============================================================
  router.get('/tiers', (req, res) => {
    res.json({ tiers: TIERS, pointValues: POINT_VALUES });
  });

  return router;
};
