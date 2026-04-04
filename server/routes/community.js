const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyAllUsers } = require('../helpers/notify');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);

  // ==================== BADGE COUNTS ====================
  // GET /api/community/badge-counts
  router.get('/badge-counts', (req, res) => {
    const liveSpaces = db.prepare("SELECT COUNT(*) as count FROM spaces WHERE status = 'live'").get().count;
    const prayerActive = db.prepare("SELECT COUNT(*) as count FROM prayer_requests WHERE isAnswered = 0 AND deletedAt IS NULL").get().count;
    const fundraisingActive = db.prepare("SELECT COUNT(*) as count FROM fundraising_campaigns WHERE isActive = 1").get().count;

    const unseenAnnouncements = db.prepare(`
      SELECT COUNT(*) as count FROM announcements
      WHERE deletedAt IS NULL AND (expiresAt IS NULL OR expiresAt > datetime('now'))
      AND id NOT IN (SELECT announcementId FROM announcement_seen WHERE userId = ?)
    `).get(req.user.id).count;

    const latestPastorMsg = db.prepare("SELECT publishedAt FROM pastor_messages ORDER BY publishedAt DESC LIMIT 1").get();
    const pastorNew = latestPastorMsg && (Date.now() - new Date(latestPastorMsg.publishedAt).getTime()) < 3 * 24 * 60 * 60 * 1000;

    const latestMagazine = db.prepare("SELECT publishedAt FROM magazines WHERE isPublished = 1 ORDER BY publishedAt DESC LIMIT 1").get();
    const magazineNew = latestMagazine && (Date.now() - new Date(latestMagazine.publishedAt).getTime()) < 7 * 24 * 60 * 60 * 1000;

    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    const groupEventsWeek = db.prepare(`
      SELECT COUNT(*) as count FROM events e
      WHERE e.date >= ? AND e.date < ?
      AND e.id IN (
        SELECT e2.id FROM events e2
        JOIN groups_table g ON e2.type = g.id
        JOIN group_members gm ON g.id = gm.groupId
        JOIN members m ON gm.memberId = m.id
        WHERE m.userId = ?
      )
    `).get(startOfWeek.toISOString().split('T')[0], endOfWeek.toISOString().split('T')[0], req.user.id).count;

    res.json({
      feed_unread: 0,
      live_spaces_active: liveSpaces > 0,
      magazine_new: !!magazineNew,
      prayer_requests_active: prayerActive,
      announcements_unread: unseenAnnouncements,
      pastor_message_new: !!pastorNew,
      group_events_this_week: groupEventsWeek,
      fundraising_active: fundraisingActive
    });
  });

  // ==================== HUB CONFIG ====================
  // GET /api/community/hub-config
  router.get('/hub-config', (req, res) => {
    let config = db.prepare('SELECT * FROM hub_config WHERE id = ?').get('default');
    if (!config) {
      db.prepare("INSERT INTO hub_config (id) VALUES ('default')").run();
      config = db.prepare('SELECT * FROM hub_config WHERE id = ?').get('default');
    }
    res.json({
      panelOrder: JSON.parse(config.panelOrder),
      hiddenPanels: JSON.parse(config.hiddenPanels)
    });
  });

  // PUT /api/community/hub-config
  router.put('/hub-config', requireRole('superadmin', 'admin'), (req, res) => {
    const { panelOrder, hiddenPanels } = req.body;
    db.prepare(`
      UPDATE hub_config SET panelOrder=?, hiddenPanels=?, updatedBy=?, updatedAt=datetime('now') WHERE id='default'
    `).run(JSON.stringify(panelOrder), JSON.stringify(hiddenPanels), req.user.id);
    res.json({ message: 'Config updated' });
  });

  // ==================== PASTOR'S WORD ====================
  // GET /api/community/pastor-messages/latest
  router.get('/pastor-messages/latest', (req, res) => {
    const msg = db.prepare(`
      SELECT pm.*, u.firstName, u.lastName, u.avatar, u.role
      FROM pastor_messages pm JOIN users u ON pm.authorId = u.id
      ORDER BY pm.publishedAt DESC LIMIT 1
    `).get();
    res.json(msg || null);
  });

  // GET /api/community/pastor-messages
  router.get('/pastor-messages', (req, res) => {
    const messages = db.prepare(`
      SELECT pm.*, u.firstName, u.lastName, u.avatar
      FROM pastor_messages pm JOIN users u ON pm.authorId = u.id
      ORDER BY pm.publishedAt DESC LIMIT 20
    `).all();
    res.json(messages);
  });

  // POST /api/community/pastor-messages
  router.post('/pastor-messages', requireRole('superadmin', 'admin'), (req, res) => {
    const { title, content, sermonVideoUrl, isPinned } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO pastor_messages (id, authorId, title, content, sermonVideoUrl, isPinned)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, title, content, sermonVideoUrl || null, isPinned ? 1 : 0);

    const msg = db.prepare('SELECT * FROM pastor_messages WHERE id = ?').get(id);
    res.status(201).json(msg);
  });

  // PUT /api/community/pastor-messages/:id
  router.put('/pastor-messages/:id', requireRole('superadmin', 'admin'), (req, res) => {
    const { title, content, sermonVideoUrl, isPinned } = req.body;
    const existing = db.prepare('SELECT * FROM pastor_messages WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    db.prepare('UPDATE pastor_messages SET title=?, content=?, sermonVideoUrl=?, isPinned=? WHERE id=?').run(
      title || existing.title, content || existing.content,
      sermonVideoUrl !== undefined ? sermonVideoUrl : existing.sermonVideoUrl,
      isPinned !== undefined ? (isPinned ? 1 : 0) : existing.isPinned, req.params.id
    );
    res.json(db.prepare('SELECT * FROM pastor_messages WHERE id = ?').get(req.params.id));
  });

  // DELETE /api/community/pastor-messages/:id
  router.delete('/pastor-messages/:id', requireRole('superadmin', 'admin'), (req, res) => {
    db.prepare('DELETE FROM pastor_messages WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  });

  // ==================== MAGAZINES ====================
  // GET /api/community/magazines
  router.get('/magazines', (req, res) => {
    const { ministryId } = req.query;
    let sql = `SELECT m.*, g.name as ministryName FROM magazines m LEFT JOIN groups_table g ON m.ministryId = g.id WHERE m.isPublished = 1`;
    const params = [];
    if (ministryId) { sql += ' AND m.ministryId = ?'; params.push(ministryId); }
    sql += ' ORDER BY m.publishedAt DESC LIMIT 10';
    res.json(db.prepare(sql).all(...params));
  });

  // GET /api/community/magazines/:id/articles
  router.get('/magazines/:id/articles', (req, res) => {
    const articles = db.prepare(`
      SELECT a.*, u.firstName, u.lastName, u.avatar
      FROM magazine_articles a JOIN users u ON a.authorId = u.id
      WHERE a.magazineId = ? ORDER BY a.publishedAt DESC
    `).all(req.params.id);
    res.json(articles);
  });

  // POST /api/community/magazines
  router.post('/magazines', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { ministryId, title, coverImageUrl } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const lastEdition = db.prepare('SELECT MAX(editionNumber) as max FROM magazines WHERE ministryId = ?').get(ministryId || null);
    const id = uuidv4();
    db.prepare(`
      INSERT INTO magazines (id, ministryId, title, editionNumber, coverImageUrl, createdBy)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, ministryId || null, title, (lastEdition.max || 0) + 1, coverImageUrl || null, req.user.id);
    res.status(201).json(db.prepare('SELECT * FROM magazines WHERE id = ?').get(id));
  });

  // PUT /api/community/magazines/:id/publish
  router.put('/magazines/:id/publish', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    db.prepare("UPDATE magazines SET isPublished = 1, publishedAt = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ message: 'Published' });
  });

  // POST /api/community/magazines/:id/articles
  router.post('/magazines/:id/articles', requireRole('superadmin', 'admin', 'ministry_leader'), (req, res) => {
    const { title, content, category, coverImageUrl, estimatedReadMinutes } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO magazine_articles (id, magazineId, title, content, authorId, category, coverImageUrl, estimatedReadMinutes, publishedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, req.params.id, title, content, req.user.id, category || 'news', coverImageUrl || null, estimatedReadMinutes || 3);
    res.status(201).json(db.prepare('SELECT * FROM magazine_articles WHERE id = ?').get(id));
  });

  // ==================== PRAYER WALL ====================
  // GET /api/community/prayer-requests
  router.get('/prayer-requests', (req, res) => {
    const { limit = 10 } = req.query;
    const isLeader = ['superadmin', 'admin', 'ministry_leader'].includes(req.user.role);

    let sql = `SELECT pr.*, u.firstName, u.lastName, u.avatar FROM prayer_requests pr
               JOIN users u ON pr.userId = u.id WHERE pr.deletedAt IS NULL`;

    if (!isLeader) {
      sql += " AND pr.visibility != 'leaders_only'";
    }

    sql += ' ORDER BY pr.isAnswered ASC, pr.createdAt DESC LIMIT ?';
    const requests = db.prepare(sql).all(Number(limit));

    const enriched = requests.map(pr => {
      const prayingCount = db.prepare("SELECT COUNT(*) as count FROM prayer_interactions WHERE prayerRequestId = ? AND type = 'praying'").get(pr.id).count;
      const heartCount = db.prepare("SELECT COUNT(*) as count FROM prayer_interactions WHERE prayerRequestId = ? AND type = 'heart'").get(pr.id).count;
      const userPraying = db.prepare("SELECT id FROM prayer_interactions WHERE prayerRequestId = ? AND userId = ? AND type = 'praying'").get(pr.id, req.user.id);
      const userHeart = db.prepare("SELECT id FROM prayer_interactions WHERE prayerRequestId = ? AND userId = ? AND type = 'heart'").get(pr.id, req.user.id);

      return {
        ...pr,
        firstName: pr.visibility === 'anonymous' && pr.userId !== req.user.id ? 'Anonymous' : pr.firstName,
        lastName: pr.visibility === 'anonymous' && pr.userId !== req.user.id ? '' : pr.lastName,
        avatar: pr.visibility === 'anonymous' && pr.userId !== req.user.id ? null : pr.avatar,
        prayingCount,
        heartCount,
        userPraying: !!userPraying,
        userHeart: !!userHeart
      };
    });

    res.json(enriched);
  });

  // POST /api/community/prayer-requests
  router.post('/prayer-requests', (req, res) => {
    const { title, content, visibility, category } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO prayer_requests (id, userId, title, content, visibility, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, title || null, content, visibility || 'public', category || 'other');

    // Notify all users about new prayer request (if public)
    if (visibility !== 'leaders_only') {
      const user = db.prepare('SELECT firstName, lastName FROM users WHERE id = ?').get(req.user.id);
      notifyAllUsers(db, {
        type: 'new_prayer',
        title: 'New Prayer Request',
        message: title || (content.substring(0, 60) + (content.length > 60 ? '...' : '')),
        refId: id,
        excludeUserId: req.user.id,
      });
    }

    res.status(201).json(db.prepare('SELECT * FROM prayer_requests WHERE id = ?').get(id));
  });

  // POST /api/community/prayer-requests/:id/pray
  router.post('/prayer-requests/:id/pray', (req, res) => {
    const existing = db.prepare("SELECT id FROM prayer_interactions WHERE prayerRequestId = ? AND userId = ? AND type = 'praying'").get(req.params.id, req.user.id);
    if (existing) {
      db.prepare('DELETE FROM prayer_interactions WHERE id = ?').run(existing.id);
      res.json({ action: 'removed' });
    } else {
      db.prepare("INSERT INTO prayer_interactions (id, prayerRequestId, userId, type) VALUES (?, ?, ?, 'praying')").run(uuidv4(), req.params.id, req.user.id);
      res.json({ action: 'added' });
    }
  });

  // POST /api/community/prayer-requests/:id/heart
  router.post('/prayer-requests/:id/heart', (req, res) => {
    const existing = db.prepare("SELECT id FROM prayer_interactions WHERE prayerRequestId = ? AND userId = ? AND type = 'heart'").get(req.params.id, req.user.id);
    if (existing) {
      db.prepare('DELETE FROM prayer_interactions WHERE id = ?').run(existing.id);
      res.json({ action: 'removed' });
    } else {
      db.prepare("INSERT INTO prayer_interactions (id, prayerRequestId, userId, type) VALUES (?, ?, ?, 'heart')").run(uuidv4(), req.params.id, req.user.id);
      res.json({ action: 'added' });
    }
  });

  // PUT /api/community/prayer-requests/:id/answered
  router.put('/prayer-requests/:id/answered', (req, res) => {
    const pr = db.prepare('SELECT * FROM prayer_requests WHERE id = ?').get(req.params.id);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.userId !== req.user.id && !['superadmin', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only author can mark as answered' });
    }
    db.prepare("UPDATE prayer_requests SET isAnswered = 1, answeredAt = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ message: 'Marked as answered' });
  });

  // ==================== FUNDRAISING ====================
  // GET /api/community/fundraising
  router.get('/fundraising', (req, res) => {
    const { active } = req.query;
    let sql = 'SELECT * FROM fundraising_campaigns';
    if (active === 'true') sql += ' WHERE isActive = 1';
    sql += ' ORDER BY endDate ASC';

    const campaigns = db.prepare(sql).all();
    const enriched = campaigns.map(c => {
      const currentAmount = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM fundraising_donations WHERE campaignId = ?').get(c.id).total;
      const donorCount = db.prepare('SELECT COUNT(DISTINCT userId) as count FROM fundraising_donations WHERE campaignId = ?').get(c.id).count;
      const lastDonation = db.prepare('SELECT donatedAt FROM fundraising_donations WHERE campaignId = ? ORDER BY donatedAt DESC LIMIT 1').get(c.id);
      return { ...c, currentAmount, donorCount, lastDonation: lastDonation ? lastDonation.donatedAt : null };
    });
    res.json(enriched);
  });

  // POST /api/community/fundraising
  router.post('/fundraising', requireRole('superadmin', 'admin'), (req, res) => {
    const { title, description, goalAmount, startDate, endDate, coverImageUrl } = req.body;
    if (!title || !goalAmount || !startDate || !endDate) {
      return res.status(400).json({ error: 'title, goalAmount, startDate, endDate required' });
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO fundraising_campaigns (id, title, description, goalAmount, coverImageUrl, startDate, endDate, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description || null, goalAmount, coverImageUrl || null, startDate, endDate, req.user.id);

    notifyAllUsers(db, {
      type: 'new_fundraising',
      title: 'New Fundraising Campaign',
      message: `${title} - Goal: $${goalAmount}`,
      refId: id,
      excludeUserId: req.user.id,
    });

    res.status(201).json(db.prepare('SELECT * FROM fundraising_campaigns WHERE id = ?').get(id));
  });

  // PUT /api/community/fundraising/:id
  router.put('/fundraising/:id', requireRole('superadmin', 'admin'), (req, res) => {
    const existing = db.prepare('SELECT * FROM fundraising_campaigns WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { title, description, goalAmount, startDate, endDate, coverImageUrl, isActive } = req.body;
    db.prepare(`UPDATE fundraising_campaigns SET title=?, description=?, goalAmount=?, startDate=?, endDate=?, coverImageUrl=?, isActive=? WHERE id=?`).run(
      title || existing.title, description !== undefined ? description : existing.description,
      goalAmount || existing.goalAmount, startDate || existing.startDate, endDate || existing.endDate,
      coverImageUrl !== undefined ? coverImageUrl : existing.coverImageUrl,
      isActive !== undefined ? (isActive ? 1 : 0) : existing.isActive, req.params.id
    );
    res.json(db.prepare('SELECT * FROM fundraising_campaigns WHERE id = ?').get(req.params.id));
  });

  // POST /api/community/fundraising/:id/donate
  router.post('/fundraising/:id/donate', (req, res) => {
    const { amount, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
    const id = uuidv4();
    db.prepare('INSERT INTO fundraising_donations (id, campaignId, userId, amount, note) VALUES (?, ?, ?, ?, ?)').run(
      id, req.params.id, req.user.id, amount, note || null
    );
    res.status(201).json({ message: 'Donation recorded', id });
  });

  // ==================== ANNOUNCEMENTS ====================
  // GET /api/community/announcements
  router.get('/announcements', (req, res) => {
    const { limit = 10 } = req.query;
    const announcements = db.prepare(`
      SELECT a.*, u.firstName, u.lastName, u.avatar
      FROM announcements a JOIN users u ON a.authorId = u.id
      WHERE a.deletedAt IS NULL AND (a.expiresAt IS NULL OR a.expiresAt > datetime('now'))
      ORDER BY a.isPinned DESC, a.publishedAt DESC LIMIT ?
    `).all(Number(limit));

    const enriched = announcements.map(a => {
      const seen = db.prepare('SELECT id FROM announcement_seen WHERE announcementId = ? AND userId = ?').get(a.id, req.user.id);
      return { ...a, seen: !!seen };
    });
    res.json(enriched);
  });

  // POST /api/community/announcements
  router.post('/announcements', requireRole('superadmin', 'admin'), (req, res) => {
    const { title, content, priority, isPinned, attachmentUrl, ctaLabel, ctaUrl, expiresAt, photo } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });
    const id = uuidv4();
    db.prepare(`
      INSERT INTO announcements (id, title, content, priority, isPinned, authorId, attachmentUrl, ctaLabel, ctaUrl, expiresAt, photo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, content, priority || 'info', isPinned ? 1 : 0, req.user.id,
           attachmentUrl || null, ctaLabel || null, ctaUrl || null, expiresAt || null, photo || null);

    const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);

    // Notify all users about the new announcement
    notifyAllUsers(db, {
      type: 'new_announcement',
      title: 'New Announcement: ' + title,
      message: content.substring(0, 120),
      refId: id,
      excludeUserId: req.user.id,
    });

    res.status(201).json(announcement);
  });

  // PUT /api/community/announcements/:id
  router.put('/announcements/:id', requireRole('superadmin', 'admin'), (req, res) => {
    const existing = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { title, content, priority, isPinned, attachmentUrl, ctaLabel, ctaUrl, expiresAt, photo } = req.body;
    db.prepare(`UPDATE announcements SET title=?, content=?, priority=?, isPinned=?, attachmentUrl=?, ctaLabel=?, ctaUrl=?, expiresAt=?, photo=? WHERE id=?`).run(
      title || existing.title, content || existing.content, priority || existing.priority,
      isPinned !== undefined ? (isPinned ? 1 : 0) : existing.isPinned,
      attachmentUrl !== undefined ? attachmentUrl : existing.attachmentUrl,
      ctaLabel !== undefined ? ctaLabel : existing.ctaLabel,
      ctaUrl !== undefined ? ctaUrl : existing.ctaUrl,
      expiresAt !== undefined ? expiresAt : existing.expiresAt,
      photo !== undefined ? photo : existing.photo, req.params.id
    );
    res.json(db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id));
  });

  // DELETE /api/community/announcements/:id (soft delete)
  router.delete('/announcements/:id', requireRole('superadmin', 'admin'), (req, res) => {
    db.prepare("UPDATE announcements SET deletedAt = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ message: 'Deleted' });
  });

  // POST /api/community/announcements/seen
  router.post('/announcements/seen', (req, res) => {
    const unseen = db.prepare(`
      SELECT id FROM announcements WHERE deletedAt IS NULL
      AND id NOT IN (SELECT announcementId FROM announcement_seen WHERE userId = ?)
    `).all(req.user.id);

    for (const a of unseen) {
      db.prepare('INSERT OR IGNORE INTO announcement_seen (id, announcementId, userId) VALUES (?, ?, ?)').run(
        uuidv4(), a.id, req.user.id
      );
    }
    res.json({ marked: unseen.length });
  });

  // ==================== EVENT RSVP ====================
  // POST /api/community/events/:id/rsvp
  router.post('/events/:id/rsvp', (req, res) => {
    try {
      db.prepare('INSERT INTO event_rsvps (id, eventId, userId) VALUES (?, ?, ?)').run(
        uuidv4(), req.params.id, req.user.id
      );
      res.status(201).json({ message: 'RSVP confirmed' });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.json({ message: 'Already RSVPd' });
      throw e;
    }
  });

  // DELETE /api/community/events/:id/rsvp
  router.delete('/events/:id/rsvp', (req, res) => {
    db.prepare('DELETE FROM event_rsvps WHERE eventId = ? AND userId = ?').run(req.params.id, req.user.id);
    res.json({ message: 'RSVP cancelled' });
  });

  // ==================== BIRTHDAYS ====================
  // GET /api/community/birthdays
  router.get('/birthdays', (req, res) => {
    const { days = 30 } = req.query;
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();

    // Get members with birthdays in the next N days
    const members = db.prepare(`
      SELECT m.id, m.firstName, m.lastName, m.birthDate, u.avatar, u.id as userId
      FROM members m LEFT JOIN users u ON m.userId = u.id
      WHERE m.birthDate IS NOT NULL AND m.status = 'active'
    `).all();

    const upcoming = members.filter(m => {
      if (!m.birthDate) return false;
      const [year, month, day] = m.birthDate.split('-').map(Number);
      const bday = new Date(today.getFullYear(), month - 1, day);
      if (bday < today) bday.setFullYear(bday.getFullYear() + 1);
      const diffDays = Math.ceil((bday - today) / (1000 * 60 * 60 * 24));
      m.daysUntil = diffDays;
      m.isToday = diffDays === 0;
      return diffDays >= 0 && diffDays <= Number(days);
    }).sort((a, b) => a.daysUntil - b.daysUntil);

    res.json(upcoming);
  });

  return router;
};
