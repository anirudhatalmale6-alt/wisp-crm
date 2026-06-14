const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const settings = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(s => settings[s.key] = s.value);

    const totalClients = db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
    const activeClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get().count;
    const suspendedClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'suspended'").get().count;

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}`;

    const monthlyIncome = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE created_at >= ? AND created_at <= ?"
    ).get(monthStart, monthEnd + ' 23:59:59').total;

    // Previous month income
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthStart = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-01`;
    const prevMonthEnd = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-${new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate()}`;
    const prevMonthIncome = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE created_at >= ? AND created_at <= ?"
    ).get(prevMonthStart, prevMonthEnd + ' 23:59:59').total;

    // New clients this month
    const newClientsMonth = db.prepare(
      "SELECT COUNT(*) as count FROM clients WHERE created_at >= ? AND created_at <= ?"
    ).get(monthStart, monthEnd + ' 23:59:59').count;

    const newClientsMonthList = db.prepare(`
      SELECT c.id, c.first_name, c.last_name, c.phone, c.status, c.created_at,
             p.name as plan_name
      FROM clients c
      LEFT JOIN plans p ON c.plan_id = p.id
      WHERE c.created_at >= ? AND c.created_at <= ?
      ORDER BY c.created_at DESC
    `).all(monthStart, monthEnd + ' 23:59:59');

    const pendingInvoices = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE status = 'pending'").get().count;
    const overdueInvoices = db.prepare(
      "SELECT COUNT(*) as count FROM invoices WHERE status = 'pending' AND due_date < date('now')"
    ).get().count;

    const pendingAmount = db.prepare(
      "SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE status = 'pending'"
    ).get().total;

    const recentPayments = db.prepare(`
      SELECT p.*, c.first_name, c.last_name, c.phone
      FROM payments p
      JOIN clients c ON p.client_id = c.id
      ORDER BY p.created_at DESC LIMIT 10
    `).all();

    const overdueClients = db.prepare(`
      SELECT c.id, c.first_name, c.last_name, c.phone, c.status,
             i.invoice_number, i.total, i.due_date
      FROM clients c
      JOIN invoices i ON i.client_id = c.id
      WHERE i.status = 'pending' AND i.due_date < date('now')
      ORDER BY i.due_date ASC LIMIT 10
    `).all();

    // Clients with pending invoices (grouped by client)
    const clientsPendingInvoices = db.prepare(`
      SELECT c.id, c.first_name, c.last_name, c.phone, c.status,
             COUNT(i.id) as invoice_count, SUM(i.total) as total_pending,
             MIN(i.due_date) as oldest_due
      FROM clients c
      JOIN invoices i ON i.client_id = c.id
      WHERE i.status = 'pending'
      GROUP BY c.id
      ORDER BY total_pending DESC
    `).all();

    const planDistribution = db.prepare(`
      SELECT p.id, p.name, COUNT(c.id) as count
      FROM plans p
      LEFT JOIN clients c ON c.plan_id = p.id
      GROUP BY p.id
      ORDER BY count DESC
    `).all();

    // Secretary payments today - payments registered by non-admin users today
    const today = now.toISOString().split('T')[0];
    const secretaryPayments = db.prepare(`
      SELECT p.*, c.first_name, c.last_name, c.phone, u.name as registered_by
      FROM payments p
      JOIN clients c ON p.client_id = c.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.user_id IS NOT NULL
        AND u.role != 'admin'
        AND p.created_at >= ?
        AND p.created_at <= ?
      ORDER BY p.created_at DESC
    `).all(today, today + ' 23:59:59');

    const secretaryTotal = secretaryPayments.reduce((sum, p) => sum + p.amount, 0);

    res.render('dashboard', {
      settings,
      totalClients, activeClients, suspendedClients,
      monthlyIncome, prevMonthIncome, newClientsMonth, newClientsMonthList,
      pendingInvoices, overdueInvoices, pendingAmount, clientsPendingInvoices,
      recentPayments, overdueClients, planDistribution,
      secretaryPayments, secretaryTotal
    });
  });

  return router;
};
