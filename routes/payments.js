const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // List payments
  router.get('/', (req, res) => {
    const { client_id, date_from, date_to } = req.query;
    let sql = `SELECT p.*, c.first_name, c.last_name, c.phone, i.invoice_number
               FROM payments p JOIN clients c ON p.client_id = c.id
               LEFT JOIN invoices i ON p.invoice_id = i.id WHERE 1=1`;
    const params = [];

    if (client_id) { sql += ` AND p.client_id = ?`; params.push(client_id); }
    if (date_from) { sql += ` AND p.created_at >= ?`; params.push(date_from); }
    if (date_to) { sql += ` AND p.created_at <= ?`; params.push(date_to + ' 23:59:59'); }

    sql += ' ORDER BY p.created_at DESC';
    const payments = db.prepare(sql).all(...params);

    const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0);

    res.render('payments/index', { payments, totalAmount, filters: req.query, settings: getSettings() });
  });

  // New payment form
  router.get('/new', (req, res) => {
    const clients = db.prepare("SELECT id, first_name, last_name, phone FROM clients ORDER BY first_name").all();
    const clientId = req.query.client_id;
    let pendingInvoices = [];
    if (clientId) {
      pendingInvoices = db.prepare("SELECT * FROM invoices WHERE client_id = ? AND status = 'pending' ORDER BY due_date").all(clientId);
    }
    res.render('payments/form', { clients, pendingInvoices, clientId, settings: getSettings() });
  });

  // Create payment
  router.post('/', (req, res) => {
    const { client_id, invoice_id, amount, payment_method, reference, notes } = req.body;

    db.prepare('INSERT INTO payments (client_id, invoice_id, amount, payment_method, reference, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
      client_id, invoice_id || null, parseFloat(amount), payment_method || 'cash', reference || null, notes || null
    );

    // Mark invoice as paid if invoice_id provided
    if (invoice_id) {
      const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice_id);
      const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE invoice_id = ?').get(invoice_id).total;
      if (totalPaid >= invoice.total) {
        const now = new Date().toISOString().split('T')[0];
        db.prepare("UPDATE invoices SET status = 'paid', paid_date = ? WHERE id = ?").run(now, invoice_id);
      }
    }

    // Reactivate client and services if suspended and all invoices paid
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    if (client && client.status === 'suspended') {
      const pendingCount = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE client_id = ? AND status = 'pending'").get(client_id).count;
      if (pendingCount === 0) {
        db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(client_id);
        db.prepare("UPDATE client_services SET status = 'active' WHERE client_id = ? AND status = 'suspended'").run(client_id);
        db.prepare("INSERT INTO service_cuts (client_id, action, reason) VALUES (?, 'reconnect', 'Pago recibido - reconexión automática')").run(client_id);

        // Queue reconnect for all services
        const services = db.prepare('SELECT * FROM client_services WHERE client_id = ?').all(client_id);
        for (const svc of services) {
          db.prepare(`INSERT INTO mikrotik_queue (client_id, service_id, action, pppoe_user, ip_address, connection_type, client_name)
            VALUES (?, ?, 'reconnect', ?, ?, ?, ?)`).run(
            client_id, svc.id, svc.pppoe_user || null, svc.ip_address || null,
            svc.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
          );
        }
      }
    }

    req.session.success = 'Pago registrado exitosamente';
    res.redirect('/payments');
  });

  return router;
};
