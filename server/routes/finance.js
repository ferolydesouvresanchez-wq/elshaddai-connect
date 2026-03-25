const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticate, requireRole } = require('../middleware/auth');

module.exports = function(db) {
  const router = express.Router();
  router.use(authenticate);
  router.use(requireRole('superadmin', 'admin'));

  // GET /api/finance
  router.get('/', (req, res) => {
    const { type, category, month, year, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT t.*, m.firstName as memberFirst, m.lastName as memberLast
               FROM transactions t LEFT JOIN members m ON t.memberId = m.id WHERE 1=1`;
    const params = [];

    if (type) { sql += ' AND t.type = ?'; params.push(type); }
    if (category) { sql += ' AND t.category = ?'; params.push(category); }
    if (month && year) {
      const datePrefix = `${year}-${String(month).padStart(2, '0')}`;
      sql += " AND t.date LIKE ? || '%'";
      params.push(datePrefix);
    }

    const countSql = sql.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM');
    const total = db.prepare(countSql).get(...params).total;

    sql += ' ORDER BY t.date DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const transactions = db.prepare(sql).all(...params);
    res.json({ transactions, total });
  });

  // GET /api/finance/summary
  router.get('/summary', (req, res) => {
    const { month, year } = req.query;
    const y = year || new Date().getFullYear();
    const m = month || (new Date().getMonth() + 1);
    const datePrefix = `${y}-${String(m).padStart(2, '0')}`;

    const income = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'income' AND date LIKE ? || '%'"
    ).get(datePrefix).total;

    const expenses = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'expense' AND date LIKE ? || '%'"
    ).get(datePrefix).total;

    const byCategory = db.prepare(
      "SELECT category, type, SUM(amount) as total FROM transactions WHERE date LIKE ? || '%' GROUP BY category, type"
    ).all(datePrefix);

    res.json({ month: m, year: y, income, expenses, net: income - expenses, byCategory });
  });

  // POST /api/finance
  router.post('/', (req, res) => {
    const { type, category, amount, description, memberId, date, paymentMethod, reference } = req.body;
    if (!type || !category || !amount || !date) {
      return res.status(400).json({ error: 'type, category, amount, date required' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO transactions (id, type, category, amount, description, memberId, date, paymentMethod, reference, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, type, category, amount, description || null, memberId || null,
           date, paymentMethod || null, reference || null, req.user.id);

    const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    res.status(201).json(transaction);
  });

  // PUT /api/finance/:id
  router.put('/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    const { type, category, amount, description, memberId, date, paymentMethod, reference } = req.body;
    db.prepare(`
      UPDATE transactions SET type=?, category=?, amount=?, description=?, memberId=?, date=?, paymentMethod=?, reference=?
      WHERE id = ?
    `).run(
      type || existing.type, category || existing.category,
      amount !== undefined ? amount : existing.amount,
      description !== undefined ? description : existing.description,
      memberId !== undefined ? memberId : existing.memberId,
      date || existing.date,
      paymentMethod !== undefined ? paymentMethod : existing.paymentMethod,
      reference !== undefined ? reference : existing.reference,
      req.params.id
    );

    const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    res.json(transaction);
  });

  // DELETE /api/finance/:id
  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
    res.json({ message: 'Transaction deleted' });
  });

  return router;
};
