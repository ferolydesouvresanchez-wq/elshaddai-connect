const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Use RAILWAY_VOLUME_MOUNT_PATH for persistent storage on Railway
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'elshaddai.db');

// Ensure data directory exists
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) { fs.mkdirSync(DATA_DIR, { recursive: true }); }
console.log('Database path:', DB_PATH);

function initDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Users & Authentication
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password TEXT NOT NULL,
      firstName TEXT NOT NULL,
      lastName TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('superadmin','admin','ministry_leader','member')),
      phone TEXT,
      avatar TEXT,
      profileVisibility TEXT DEFAULT 'public' CHECK(profileVisibility IN ('public','private')),
      birthDate TEXT,
      lang TEXT DEFAULT 'en',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      active INTEGER DEFAULT 1,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    -- Members (church membership records)
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      userId TEXT REFERENCES users(id) ON DELETE SET NULL,
      firstName TEXT NOT NULL,
      lastName TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      address TEXT,
      birthDate TEXT,
      gender TEXT,
      memberSince TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      notes TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    -- Attendance
    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      memberId TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      eventType TEXT DEFAULT 'sunday_service',
      present INTEGER DEFAULT 1,
      notes TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Events
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      time TEXT,
      endTime TEXT,
      location TEXT,
      type TEXT DEFAULT 'general',
      recurring INTEGER DEFAULT 0,
      createdBy TEXT REFERENCES users(id),
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    -- Finance: Transactions
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('income','expense')),
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      memberId TEXT REFERENCES members(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      paymentMethod TEXT,
      reference TEXT,
      createdBy TEXT REFERENCES users(id),
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Groups / Ministries
    CREATE TABLE IF NOT EXISTS groups_table (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'ministry',
      leaderId TEXT REFERENCES users(id) ON DELETE SET NULL,
      meetingDay TEXT,
      meetingTime TEXT,
      active INTEGER DEFAULT 1,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    -- Group Members
    CREATE TABLE IF NOT EXISTS group_members (
      id TEXT PRIMARY KEY,
      groupId TEXT NOT NULL REFERENCES groups_table(id) ON DELETE CASCADE,
      memberId TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member',
      joinedAt TEXT DEFAULT (datetime('now')),
      UNIQUE(groupId, memberId)
    );

    -- Courses
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      groupId TEXT NOT NULL REFERENCES groups_table(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      sortOrder INTEGER DEFAULT 0,
      createdBy TEXT REFERENCES users(id),
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Course Lessons (video/pdf)
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      courseId TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('video','pdf','youtube','vimeo')),
      url TEXT,
      filePath TEXT,
      duration INTEGER,
      sortOrder INTEGER DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Lesson Progress
    CREATE TABLE IF NOT EXISTS lesson_progress (
      id TEXT PRIMARY KEY,
      lessonId TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      completed INTEGER DEFAULT 0,
      progress REAL DEFAULT 0,
      lastPosition REAL DEFAULT 0,
      updatedAt TEXT DEFAULT (datetime('now')),
      UNIQUE(lessonId, userId)
    );

    -- Social: Follows
    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      followerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followingId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','pending','rejected')),
      createdAt TEXT DEFAULT (datetime('now')),
      UNIQUE(followerId, followingId)
    );

    -- Social: Posts
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      authorId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT,
      mediaUrl TEXT,
      mediaType TEXT,
      visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public','followers','group')),
      groupId TEXT REFERENCES groups_table(id) ON DELETE SET NULL,
      repostOfId TEXT REFERENCES posts(id) ON DELETE SET NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Social: Reactions
    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      postId TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('like','love','prayer')),
      createdAt TEXT DEFAULT (datetime('now')),
      UNIQUE(postId, userId, type)
    );

    -- Social: Comments
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      postId TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Live Spaces
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      hostId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'audio' CHECK(type IN ('audio','video')),
      status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','ended')),
      scheduledAt TEXT,
      startedAt TEXT,
      endedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Space Participants
    CREATE TABLE IF NOT EXISTS space_participants (
      id TEXT PRIMARY KEY,
      spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joinedAt TEXT DEFAULT (datetime('now')),
      leftAt TEXT,
      UNIQUE(spaceId, userId)
    );

    -- Space Chat Messages
    CREATE TABLE IF NOT EXISTS space_chats (
      id TEXT PRIMARY KEY,
      spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Stars
    CREATE TABLE IF NOT EXISTS stars (
      id TEXT PRIMARY KEY,
      spaceId TEXT REFERENCES spaces(id) ON DELETE SET NULL,
      fromUserId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      toUserId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      count INTEGER DEFAULT 1,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Badges
    CREATE TABLE IF NOT EXISTS badges (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      awardedAt TEXT DEFAULT (datetime('now'))
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      refId TEXT,
      read INTEGER DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Pastor Messages
    CREATE TABLE IF NOT EXISTS pastor_messages (
      id TEXT PRIMARY KEY,
      authorId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sermonVideoUrl TEXT,
      isPinned INTEGER DEFAULT 0,
      publishedAt TEXT DEFAULT (datetime('now')),
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Magazines
    CREATE TABLE IF NOT EXISTS magazines (
      id TEXT PRIMARY KEY,
      ministryId TEXT REFERENCES groups_table(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      editionNumber INTEGER DEFAULT 1,
      coverImageUrl TEXT,
      isPublished INTEGER DEFAULT 0,
      publishedAt TEXT,
      createdBy TEXT REFERENCES users(id),
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Magazine Articles
    CREATE TABLE IF NOT EXISTS magazine_articles (
      id TEXT PRIMARY KEY,
      magazineId TEXT NOT NULL REFERENCES magazines(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      authorId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT DEFAULT 'news' CHECK(category IN ('testimony','devotional','events','interview','news')),
      coverImageUrl TEXT,
      estimatedReadMinutes INTEGER DEFAULT 3,
      publishedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Prayer Requests
    CREATE TABLE IF NOT EXISTS prayer_requests (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT,
      content TEXT NOT NULL,
      visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public','anonymous','leaders_only')),
      category TEXT DEFAULT 'other' CHECK(category IN ('health','family','work','finances','relationships','other')),
      isAnswered INTEGER DEFAULT 0,
      answeredAt TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      deletedAt TEXT
    );

    -- Prayer Interactions
    CREATE TABLE IF NOT EXISTS prayer_interactions (
      id TEXT PRIMARY KEY,
      prayerRequestId TEXT NOT NULL REFERENCES prayer_requests(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('praying','heart')),
      createdAt TEXT DEFAULT (datetime('now')),
      UNIQUE(prayerRequestId, userId, type)
    );

    -- Fundraising Campaigns
    CREATE TABLE IF NOT EXISTS fundraising_campaigns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      goalAmount REAL NOT NULL,
      coverImageUrl TEXT,
      isActive INTEGER DEFAULT 1,
      startDate TEXT NOT NULL,
      endDate TEXT NOT NULL,
      createdBy TEXT REFERENCES users(id),
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Fundraising Donations
    CREATE TABLE IF NOT EXISTS fundraising_donations (
      id TEXT PRIMARY KEY,
      campaignId TEXT NOT NULL REFERENCES fundraising_campaigns(id) ON DELETE CASCADE,
      userId TEXT REFERENCES users(id) ON DELETE SET NULL,
      amount REAL NOT NULL,
      note TEXT,
      donatedAt TEXT DEFAULT (datetime('now'))
    );

    -- Announcements
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT DEFAULT 'info' CHECK(priority IN ('urgent','official','positive','info')),
      isPinned INTEGER DEFAULT 0,
      authorId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attachmentUrl TEXT,
      ctaLabel TEXT,
      ctaUrl TEXT,
      publishedAt TEXT DEFAULT (datetime('now')),
      expiresAt TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      deletedAt TEXT
    );

    -- Announcement Seen (track read status)
    CREATE TABLE IF NOT EXISTS announcement_seen (
      id TEXT PRIMARY KEY,
      announcementId TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seenAt TEXT DEFAULT (datetime('now')),
      UNIQUE(announcementId, userId)
    );

    -- Event RSVPs
    CREATE TABLE IF NOT EXISTS event_rsvps (
      id TEXT PRIMARY KEY,
      eventId TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      createdAt TEXT DEFAULT (datetime('now')),
      UNIQUE(eventId, userId)
    );

    -- Conversations (messaging)
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      name TEXT,
      isGroup INTEGER DEFAULT 0,
      createdBy TEXT REFERENCES users(id),
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Conversation Participants
    CREATE TABLE IF NOT EXISTS conversation_participants (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joinedAt TEXT DEFAULT (datetime('now')),
      UNIQUE(conversationId, userId)
    );

    -- Chat Messages
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      senderId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    -- Chat Message Read Status
    CREATE TABLE IF NOT EXISTS chat_message_reads (
      messageId TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      readAt TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(messageId, userId)
    );

    -- App Settings (key-value store for bannerPhotos, userPermissions, etc.)
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedBy TEXT REFERENCES users(id),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    -- Community Hub Config
    CREATE TABLE IF NOT EXISTS hub_config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      panelOrder TEXT DEFAULT '["pastor","rankings","magazine","prayer","fundraising","announcements","group_events","upcoming_events","birthdays"]',
      hiddenPanels TEXT DEFAULT '[]',
      updatedBy TEXT REFERENCES users(id),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_attendance_member ON attendance(memberId);
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(authorId);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(createdAt);
    CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(postId);
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(postId);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(followerId);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(followingId);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(userId, read);
    CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status);
    CREATE INDEX IF NOT EXISTS idx_stars_to ON stars(toUserId);
    CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(groupId);
    CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(courseId);
    CREATE INDEX IF NOT EXISTS idx_pastor_messages_published ON pastor_messages(publishedAt);
    CREATE INDEX IF NOT EXISTS idx_prayer_requests_created ON prayer_requests(createdAt);
    CREATE INDEX IF NOT EXISTS idx_fundraising_active ON fundraising_campaigns(isActive);
    CREATE INDEX IF NOT EXISTS idx_announcements_published ON announcements(publishedAt);
    CREATE INDEX IF NOT EXISTS idx_announcements_seen ON announcement_seen(userId);
    CREATE INDEX IF NOT EXISTS idx_event_rsvps ON event_rsvps(eventId);
    CREATE INDEX IF NOT EXISTS idx_members_birthdate ON members(birthDate);
    CREATE INDEX IF NOT EXISTS idx_users_birthdate ON users(birthDate);
    CREATE INDEX IF NOT EXISTS idx_conv_participants ON conversation_participants(userId);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversationId);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(createdAt);
  `);

  // Migration: add status column if missing
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('status')) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected'))");
    db.exec("UPDATE users SET status = 'approved'");
    console.log('Migration: added status column to users, existing users set to approved');
  }

  // Seed default admin user if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const adminId = uuidv4();
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (id, username, email, password, firstName, lastName, role, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')
    `).run(adminId, 'admin@elshaddai.com', 'admin@elshaddai.com', hashedPassword, 'Admin', 'Church', 'superadmin');

    // Create corresponding member record
    db.prepare(`
      INSERT INTO members (id, userId, firstName, lastName, email, status, memberSince)
      VALUES (?, ?, ?, ?, ?, 'active', date('now'))
    `).run(uuidv4(), adminId, 'Admin', 'Church', 'admin@elshaddai.com');

    console.log('Default admin user created: admin@elshaddai.com / admin123');
  }

  return db;
}

module.exports = { initDatabase, DB_PATH };
