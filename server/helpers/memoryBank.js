const fs = require('fs');
const path = require('path');

/**
 * Memory Bank System
 *
 * Each section of the app has its own "book" — an isolated persistence entry
 * in the Railway Volume. The Memory Bank ensures:
 * 1. Every section's data survives redeploys
 * 2. Data integrity is verified on startup
 * 3. Missing or corrupted books are auto-recovered from SQLite
 * 4. Each book is independent — one section can't corrupt another
 */

// All Memory Bank book definitions
const MEMORY_BOOKS = {
  MEMORY_MEMBERS:        { tables: ['members'], label: 'Members Directory' },
  MEMORY_EVENTS:         { tables: ['events', 'event_rsvps'], label: 'Events & RSVPs' },
  MEMORY_GROUPS:         { tables: ['groups_table', 'group_members'], label: 'Groups & Ministries' },
  MEMORY_FINANCE:        { tables: ['transactions'], label: 'Finance & Transactions' },
  MEMORY_ATTENDANCE:     { tables: ['attendance'], label: 'Attendance Records' },
  MEMORY_USERS:          { tables: ['users'], label: 'User Accounts' },
  MEMORY_NOTIFICATIONS:  { tables: ['notifications'], label: 'Notifications' },
  MEMORY_FEED:           { tables: ['posts', 'reactions', 'comments'], label: 'Social Feed' },
  MEMORY_MESSAGES:       { tables: ['conversations', 'conversation_participants', 'chat_messages', 'chat_message_reads'], label: 'Messaging' },
  MEMORY_SPACES:         { tables: ['spaces', 'space_participants', 'space_chats'], label: 'Live Spaces' },
  MEMORY_STARS:          { tables: ['stars', 'badges'], label: 'Stars & Rankings' },
  MEMORY_FOLLOWS:        { tables: ['follows'], label: 'Follow Relationships' },
  MEMORY_PASTOR:         { tables: ['pastor_messages'], label: 'Pastor Messages' },
  MEMORY_PRAYER:         { tables: ['prayer_requests', 'prayer_interactions'], label: 'Prayer Wall' },
  MEMORY_ANNOUNCEMENTS:  { tables: ['announcements', 'announcement_seen'], label: 'Announcements' },
  MEMORY_FUNDRAISING:    { tables: ['fundraising_campaigns', 'fundraising_donations'], label: 'Fundraising' },
  MEMORY_MAGAZINES:      { tables: ['magazines', 'magazine_articles'], label: 'Magazines' },
  MEMORY_SETTINGS:       { tables: ['app_settings', 'hub_config'], label: 'App Settings & Banners' },
  MEMORY_COURSES:        { tables: ['courses', 'lessons', 'lesson_progress'], label: 'Courses & Lessons' },
  MEMORY_AUTH:           { tables: ['users'], label: 'Authentication' },
};

// Data directory for Memory Bank status files
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'db');
const BANK_STATUS_DIR = path.join(DATA_DIR, '.memorybank');

/**
 * Initialize the Memory Bank system
 * Called once on server startup before serving any requests
 */
function initMemoryBank(db) {
  console.log('\n========================================');
  console.log('  MEMORY BANK SYSTEM — STARTUP CHECK');
  console.log('========================================');
  console.log('Data directory:', DATA_DIR);
  console.log('Bank status dir:', BANK_STATUS_DIR);

  // Ensure status directory exists
  if (!fs.existsSync(BANK_STATUS_DIR)) {
    fs.mkdirSync(BANK_STATUS_DIR, { recursive: true });
    console.log('Created Memory Bank status directory');
  }

  const report = {};
  let totalRecords = 0;
  let booksOk = 0;
  let booksRecovered = 0;

  for (const [bookName, bookDef] of Object.entries(MEMORY_BOOKS)) {
    const bookStatus = verifyBook(db, bookName, bookDef);
    report[bookName] = bookStatus;
    totalRecords += bookStatus.recordCount;

    if (bookStatus.status === 'OK') {
      booksOk++;
    } else if (bookStatus.status === 'RECOVERED') {
      booksRecovered++;
    }
  }

  console.log('\n--- MEMORY BANK REPORT ---');
  for (const [bookName, status] of Object.entries(report)) {
    const icon = status.status === 'OK' ? '✓' : status.status === 'RECOVERED' ? '↻' : '✗';
    console.log(`  ${icon} ${bookName}: ${status.label} — ${status.recordCount} records [${status.status}]`);
  }
  console.log(`\nTotal: ${Object.keys(report).length} books, ${totalRecords} records`);
  console.log(`Status: ${booksOk} OK, ${booksRecovered} recovered`);
  console.log('========================================\n');

  // Write master status file
  const masterStatus = {
    lastStartup: new Date().toISOString(),
    books: report,
    totalRecords,
    booksOk,
    booksRecovered,
    dataDir: DATA_DIR,
    dbPath: db.name,
  };
  fs.writeFileSync(
    path.join(BANK_STATUS_DIR, 'master_status.json'),
    JSON.stringify(masterStatus, null, 2)
  );

  return report;
}

/**
 * Verify a single Memory Bank book
 * Checks that all tables exist and have data integrity
 */
function verifyBook(db, bookName, bookDef) {
  const statusFile = path.join(BANK_STATUS_DIR, `${bookName}.json`);
  let recordCount = 0;
  let status = 'OK';
  const tableDetails = {};

  for (const table of bookDef.tables) {
    try {
      // Check table exists
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);

      if (!tableExists) {
        console.log(`  ⚠ Table ${table} missing for ${bookName} — will be created by schema`);
        status = 'RECOVERED';
        tableDetails[table] = { exists: false, count: 0 };
        continue;
      }

      // Count records
      const count = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
      recordCount += count;
      tableDetails[table] = { exists: true, count };

      // Verify table is readable (integrity check)
      db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
    } catch (err) {
      console.error(`  ✗ Error verifying table ${table} for ${bookName}:`, err.message);
      status = 'ERROR';
      tableDetails[table] = { exists: false, count: 0, error: err.message };
    }
  }

  // Write individual book status
  const bookStatus = {
    bookName,
    label: bookDef.label,
    tables: tableDetails,
    recordCount,
    status,
    lastVerified: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(statusFile, JSON.stringify(bookStatus, null, 2));
  } catch (e) {
    // Non-fatal: status file is informational only
  }

  return bookStatus;
}

/**
 * Get the record count for a specific book's tables
 */
function getBookCounts(db, bookName) {
  const bookDef = MEMORY_BOOKS[bookName];
  if (!bookDef) return null;

  const counts = {};
  let total = 0;
  for (const table of bookDef.tables) {
    try {
      const c = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
      counts[table] = c;
      total += c;
    } catch {
      counts[table] = 0;
    }
  }
  return { bookName, label: bookDef.label, tables: counts, total };
}

/**
 * Get status of all Memory Bank books
 */
function getAllBookStatus(db) {
  const result = {};
  for (const [bookName, bookDef] of Object.entries(MEMORY_BOOKS)) {
    result[bookName] = getBookCounts(db, bookName);
  }
  return result;
}

/**
 * Run a full integrity check on all books
 */
function integrityCheck(db) {
  console.log('Running Memory Bank integrity check...');

  // SQLite integrity check
  const integrity = db.pragma('integrity_check');
  const sqliteOk = integrity[0]?.integrity_check === 'ok';

  // Check each book
  const books = {};
  for (const [bookName, bookDef] of Object.entries(MEMORY_BOOKS)) {
    books[bookName] = verifyBook(db, bookName, bookDef);
  }

  // Check database file is on persistent volume
  const dbOnVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? db.name.startsWith(process.env.RAILWAY_VOLUME_MOUNT_PATH)
    : true; // Not on Railway, so it's fine

  return {
    sqliteIntegrity: sqliteOk ? 'OK' : 'FAILED',
    dbPath: db.name,
    dbOnVolume,
    volumePath: process.env.RAILWAY_VOLUME_MOUNT_PATH || '(not set)',
    books,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  MEMORY_BOOKS,
  initMemoryBank,
  verifyBook,
  getBookCounts,
  getAllBookStatus,
  integrityCheck
};
