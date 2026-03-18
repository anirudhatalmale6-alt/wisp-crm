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

    // Generate invoices per service (supports multiple services per client)
    const activeServices = db.prepare(`
      SELECT cs.*, p.price, c.first_name, c.last_name FROM client_services cs
      JOIN plans p ON cs.plan_id = p.id
      JOIN clients c ON cs.client_id = c.id
      WHERE cs.status = 'active' AND c.status != 'inactive'
    `).all();

    let generated = 0;
    let autoPaid = 0;
    const insert = db.prepare(`INSERT INTO invoices (client_id, service_id, invoice_number, period_start, period_end, amount, tax, total, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const svc of activeServices) {
      const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${lastDay}`;
      const dueDay = Math.min(svc.billing_day || 1, lastDay);
      const dueDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;

      // Check if invoice already exists for this service+period
      const existing = db.prepare('SELECT id FROM invoices WHERE service_id = ? AND period_start = ?').get(svc.id, periodStart);
      if (existing) continue;
      // Fallback: check by client_id if no service_id match (backward compat for single-service clients)
      if (!existing) {
        const svcCount = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE client_id = ?').get(svc.client_id).count;
        if (svcCount === 1) {
          const existingByClient = db.prepare('SELECT id FROM invoices WHERE client_id = ? AND period_start = ? AND service_id IS NULL').get(svc.client_id, periodStart);
          if (existingByClient) continue;
        }
      }

      const amount = svc.price;
      const tax = amount * taxRate;
      const total = amount + tax;

      const result = insert.run(svc.client_id, svc.id, generateInvoiceNumber(), periodStart, periodEnd, amount, tax, total, dueDate);
      generated++;

      // Auto-pay if client has enough credit (balance a favor)
      const totalPaid = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE client_id = ?`).get(svc.client_id);
      const totalInvoiced = db.prepare(`SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE client_id = ? AND status != 'cancelled'`).get(svc.client_id);
      const balance = totalPaid.total - totalInvoiced.total;

      if (balance >= 0) {
        const invoiceId = result.lastInsertRowid;
        const today = new Date().toISOString().split('T')[0];
        db.prepare("UPDATE invoices SET status = 'paid', paid_date = ? WHERE id = ?").run(today, invoiceId);
        db.prepare('INSERT INTO payments (client_id, invoice_id, amount, payment_method, notes) VALUES (?, ?, ?, ?, ?)').run(
          svc.client_id, invoiceId, total, 'credit', 'Pago automático desde saldo a favor'
        );
        autoPaid++;
      }
    }

    const msg = autoPaid > 0
      ? `${generated} facturas generadas (${autoPaid} pagadas automáticamente desde saldo a favor)`
      : `${generated} facturas generadas`;
    req.session.success = msg;
    res.redirect('/invoices');
  });

  // New custom invoice form (admin only)
  router.get('/new', (req, res) => {
    if (req.session.user.role !== 'admin') {
      req.session.error = 'No tiene permisos para crear facturas';
      return res.redirect('/invoices');
    }
    const clients = db.prepare(`SELECT id, first_name, last_name, phone FROM clients WHERE status != 'inactive' ORDER BY first_name, last_name`).all();
    res.render('invoices/form', { clients, settings: getSettings(), preselect_client: req.query.client_id || '' });
  });

  // Create custom invoice (admin only)
  router.post('/create', (req, res) => {
    if (req.session.user.role !== 'admin') {
      req.session.error = 'No tiene permisos para crear facturas';
      return res.redirect('/invoices');
    }
    const { client_id, concept, amount, due_date, notes } = req.body;
    if (!client_id || !amount || !due_date) {
      req.session.error = 'Cliente, monto y fecha de vencimiento son obligatorios';
      return res.redirect('/invoices/new');
    }

    const settings = getSettings();
    const taxRate = parseFloat(settings.tax_rate || '0') / 100;
    const amt = parseFloat(amount);
    const tax = amt * taxRate;
    const total = amt + tax;

    const now = new Date();
    const periodStart = now.toISOString().split('T')[0];
    const periodEnd = due_date;

    db.prepare(`INSERT INTO invoices (client_id, invoice_number, period_start, period_end, amount, tax, total, due_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      client_id, generateInvoiceNumber(), periodStart, periodEnd, amt, tax, total, due_date,
      (concept ? concept + (notes ? '\n' + notes : '') : notes) || null
    );

    req.session.success = 'Factura personalizada creada exitosamente';
    res.redirect('/invoices');
  });

  // Single invoice view
  router.get('/:id', (req, res) => {
    const invoice = db.prepare(`SELECT i.*, c.first_name, c.last_name, c.phone, c.address, c.email,
      p.name as plan_name, p.speed_down, p.speed_up
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
