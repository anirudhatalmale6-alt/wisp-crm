const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  const generateInvoiceNumber = () => {
    const now = new Date();
    const prefix = `FAC-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const last = db.prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1").get(prefix + '%');
    let seq = 1;
    if (last) {
      const parts = last.invoice_number.split('-');
      seq = parseInt(parts[2] || '0') + 1;
    }
    return `${prefix}-${String(seq).padStart(4, '0')}`;
  };

  // List invoices
  router.get('/', (req, res) => {
    const { status, client_id, month } = req.query;
    let sql = `SELECT i.*, c.first_name, c.last_name, c.phone
               FROM invoices i JOIN clients c ON i.client_id = c.id WHERE 1=1`;
    const params = [];

    if (status) { sql += ` AND i.status = ?`; params.push(status); }
    if (client_id) { sql += ` AND i.client_id = ?`; params.push(client_id); }
    if (month) { sql += ` AND i.period_start LIKE ?`; params.push(month + '%'); }

    sql += ' ORDER BY i.created_at DESC';
    const invoices = db.prepare(sql).all(...params);
    res.render('invoices/index', { invoices, filters: req.query, settings: getSettings() });
  });

  // Generate invoices for all active clients (admin only)
  router.post('/generate', (req, res) => {
    if (req.session.user.role !== 'admin') {
      req.session.error = 'No tiene permisos para generar facturas';
      return res.redirect('/invoices');
    }
    const settings = getSettings();
    const taxRate = parseFloat(settings.tax_rate || '0') / 100;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    const clients = db.prepare(`
      SELECT c.*, p.price FROM clients c
      JOIN plans p ON c.plan_id = p.id
      WHERE c.status = 'active'
    `).all();

    let generated = 0;
    const insert = db.prepare(`INSERT INTO invoices (client_id, invoice_number, period_start, period_end, amount, tax, total, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const client of clients) {
      const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${lastDay}`;
      const dueDay = Math.min(client.billing_day || 1, lastDay);
      const dueDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;

      // Check if invoice already exists for this period
      const existing = db.prepare('SELECT id FROM invoices WHERE client_id = ? AND period_start = ?').get(client.id, periodStart);
      if (existing) continue;

      const amount = client.price;
      const tax = amount * taxRate;
      const total = amount + tax;

      insert.run(client.id, generateInvoiceNumber(), periodStart, periodEnd, amount, tax, total, dueDate);
      generated++;
    }

    req.session.success = `${generated} facturas generadas`;
    res.redirect('/invoices');
  });

  // Single invoice view
  router.get('/:id', (req, res) => {
    const invoice = db.prepare(`SELECT i.*, c.first_name, c.last_name, c.phone, c.address, c.email,
      p.name as plan_name, p.speed_down
      FROM invoices i JOIN clients c ON i.client_id = c.id
      LEFT JOIN plans p ON c.plan_id = p.id
      WHERE i.id = ?`).get(req.params.id);
    if (!invoice) return res.redirect('/invoices');

    const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at DESC').all(req.params.id);
    res.render('invoices/show', { invoice, payments, settings: getSettings() });
  });

  // Mark as paid (quick action)
  router.post('/:id/pay', (req, res) => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.redirect('/invoices');

    const now = new Date().toISOString().split('T')[0];
    db.prepare("UPDATE invoices SET status = 'paid', paid_date = ? WHERE id = ?").run(now, req.params.id);
    db.prepare('INSERT INTO payments (client_id, invoice_id, amount, payment_method, notes) VALUES (?, ?, ?, ?, ?)').run(
      invoice.client_id, invoice.id, invoice.total, req.body.payment_method || 'cash', req.body.notes || 'Pago registrado'
    );

    req.session.success = 'Pago registrado exitosamente';
    res.redirect(req.body.redirect || '/invoices');
  });

  // Cancel invoice (admin only)
  router.post('/:id/cancel', (req, res) => {
    if (req.session.user.role !== 'admin') {
      req.session.error = 'No tiene permisos para cancelar facturas';
      return res.redirect('/invoices');
    }
    db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    req.session.success = 'Factura cancelada';
    res.redirect('/invoices');
  });

  return router;
};
