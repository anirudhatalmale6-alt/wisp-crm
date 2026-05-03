const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // Helper: reactivate a suspended client
  function reactivateClient(db, clientId, client) {
    db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(clientId);
    db.prepare("UPDATE client_services SET status = 'active' WHERE client_id = ? AND status = 'suspended'").run(clientId);
    db.prepare("INSERT INTO service_cuts (client_id, action, reason) VALUES (?, 'reconnect', 'Pago recibido - reconexion manual')").run(clientId);

    const services = db.prepare('SELECT * FROM client_services WHERE client_id = ?').all(clientId);
    for (const svc of services) {
      db.prepare(`INSERT INTO mikrotik_queue (client_id, service_id, action, pppoe_user, ip_address, connection_type, client_name)
        VALUES (?, ?, 'reconnect', ?, ?, ?, ?)`).run(
        clientId, svc.id, svc.pppoe_user || null, svc.ip_address || null,
        svc.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
      );
    }
  }

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

    const userId = req.session.user ? req.session.user.id : null;
    db.prepare('INSERT INTO payments (client_id, invoice_id, amount, payment_method, reference, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      client_id, invoice_id || null, parseFloat(amount), payment_method || 'cash', reference || null, notes || null, userId
    );

    // Auto-apply: mark pending invoices as paid based on total payments vs total invoiced
    const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE client_id = ?').get(client_id).total;
    const paidInvoicesTotal = db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE client_id = ? AND status = 'paid'").get(client_id).total;
    let remaining = totalPaid - paidInvoicesTotal;
    const pendingInvoices = db.prepare("SELECT * FROM invoices WHERE client_id = ? AND status = 'pending' ORDER BY due_date ASC").all(client_id);
    const today = new Date().toISOString().split('T')[0];
    for (const inv of pendingInvoices) {
      if (remaining >= inv.total) {
        db.prepare("UPDATE invoices SET status = 'paid', paid_date = ? WHERE id = ?").run(today, inv.id);
        remaining -= inv.total;
      } else {
        break;
      }
    }

    // Check if client is suspended — ask whether to reactivate
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    if (client && client.status === 'suspended') {
      const pendingCount = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE client_id = ? AND status = 'pending'").get(client_id).count;
      const pendingTotal = db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE client_id = ? AND status = 'pending'").get(client_id).total;

      if (pendingCount === 0) {
        // All paid — auto-reactivate
        reactivateClient(db, client_id, client);
        req.session.success = 'Pago registrado. Cliente reactivado automaticamente (todas las facturas pagadas).';
        return res.redirect('/payments');
      } else {
        // Still has pending invoices — ask the user
        req.session.success = 'Pago registrado exitosamente';
        return res.redirect(`/payments/reactivate?client_id=${client_id}&pending=${pendingCount}&pending_total=${pendingTotal.toFixed(2)}`);
      }
    }

    req.session.success = 'Pago registrado exitosamente';
    res.redirect('/payments');
  });

  // Reactivation confirmation page
  router.get('/reactivate', (req, res) => {
    const { client_id, pending, pending_total } = req.query;
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    if (!client || client.status !== 'suspended') {
      return res.redirect('/payments');
    }
    const settings = getSettings();
    res.render('payments/reactivate', { client, pending, pending_total, settings });
  });

  // Process reactivation decision
  router.post('/reactivate', (req, res) => {
    const { client_id, action } = req.body;
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);

    if (action === 'reactivate' && client && client.status === 'suspended') {
      reactivateClient(db, client_id, client);
      req.session.success = `${client.first_name} ${client.last_name} reactivado exitosamente`;
    } else {
      req.session.success = `${client.first_name} ${client.last_name} se mantiene cortado`;
    }
    res.redirect('/payments');
  });

  // Delete payment (admin only)
  router.post('/:id/delete', (req, res) => {
    if (req.session.user.role !== 'admin') {
      req.session.error = 'No tiene permisos para eliminar pagos';
      return res.redirect('/payments');
    }

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!payment) {
      req.session.error = 'Pago no encontrado';
      return res.redirect('/payments');
    }

    // If this payment was linked to an invoice, revert invoice status to pending
    if (payment.invoice_id) {
      db.prepare("UPDATE invoices SET status = 'pending', paid_date = NULL WHERE id = ? AND status = 'paid'").run(payment.invoice_id);
    }

    db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
    req.session.success = 'Pago eliminado';
    res.redirect('/payments');
  });

  return router;
};
