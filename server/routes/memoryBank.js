const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { getAllBookStatus, integrityCheck, MEMORY_BOOKS } = require('../helpers/memoryBank');

module.exports = function(db) {
  const router = express.Router();

  // GET /api/memory-bank/status — Public health check for all books
  router.get('/status', (req, res) => {
    const books = getAllBookStatus(db);
    const totalRecords = Object.values(books).reduce((sum, b) => sum + b.total, 0);
    res.json({
      status: 'OK',
      totalBooks: Object.keys(books).length,
      totalRecords,
      books,
      dbPath: db.name,
      volumePath: process.env.RAILWAY_VOLUME_MOUNT_PATH || '(not set)',
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/memory-bank/integrity — Full integrity check (admin only)
  router.get('/integrity', authenticate, requireRole('superadmin', 'admin'), (req, res) => {
    const result = integrityCheck(db);
    res.json(result);
  });

  // GET /api/memory-bank/book/:name — Get specific book status
  router.get('/book/:name', (req, res) => {
    const bookName = req.params.name.toUpperCase();
    const bookDef = MEMORY_BOOKS[bookName];
    if (!bookDef) {
      return res.status(404).json({ error: `Book ${bookName} not found` });
    }

    const counts = {};
    let total = 0;
    for (const table of bookDef.tables) {
      try {
        const c = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
        counts[table] = c;
        total += c;
      } catch (e) {
        counts[table] = { error: e.message };
      }
    }

    res.json({
      bookName,
      label: bookDef.label,
      tables: counts,
      total,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
};
