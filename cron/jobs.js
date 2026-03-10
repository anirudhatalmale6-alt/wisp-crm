const cron = require('node-cron');

module.exports = function(db) {
  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // Auto-generate invoices on the 1st of each month at 6:00 AM
  cron.schedule('0 6 1 * *', () => {
    console.log('[CRON] Generating monthly invoices...');
    const settings = getSettings();
    const taxRate = parseFloat(settings.tax_rate || '0') / 100;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    const clients = db.prepare(`SELECT c.*, p.price FROM clients c
      JOIN plans p ON c.plan_id = p.id WHERE c.status = 'active'`).all();

    let count = 0;
    const prefix = `FAC-${year}${String(month + 1).padStart(2, '0')}`;

    for (const client of clients) {
      const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${lastDay}`;
      const dueDay = Math.min(client.billing_day || 1, lastDay);
      const dueDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;

      const existing = db.prepare('SELECT id FROM invoices WHERE client_id = ? AND period_start = ?').get(client.id, periodStart);
      if (existing) continue;

      const amount = client.price;
      const tax = amount * taxRate;
      const total = amount + tax;
      const seq = String(++count).padStart(4, '0');

      db.prepare(`INSERT INTO invoices (client_id, invoice_number, period_start, period_end, amount, tax, total, due_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        client.id, `${prefix}-${seq}`, periodStart, periodEnd, amount, tax, total, dueDate
      );
    }
    console.log(`[CRON] ${count} invoices generated`);
  });

  // Auto-cut service for overdue clients (daily at 8:00 AM)
  cron.schedule('0 8 * * *', () => {
    const settings = getSettings();
    if (settings.auto_cut_enabled !== '1') return;

    const graceDays = parseInt(settings.grace_days || '5');
    console.log(`[CRON] Checking for overdue clients (grace: ${graceDays} days)...`);

    const overdueClients = db.prepare(`
      SELECT DISTINCT c.id, c.first_name, c.last_name, c.phone, c.status,
        c.connection_type, c.pppoe_user, c.ip_address
      FROM clients c
      JOIN invoices i ON i.client_id = c.id
      WHERE c.status = 'active'
        AND i.status = 'pending'
        AND i.due_date < date('now', '-' || ? || ' days')
    `).all(String(graceDays));

    let cutCount = 0;

    for (const client of overdueClients) {
      db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(client.id);
      db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'cut', 'Corte automático por mora', 1)").run(client.id);

      // Queue MikroTik action
      db.prepare(`INSERT INTO mikrotik_queue (client_id, action, pppoe_user, ip_address, connection_type, client_name)
        VALUES (?, 'cut', ?, ?, ?, ?)`).run(
        client.id, client.pppoe_user || null, client.ip_address || null,
        client.connection_type || 'pppoe',
        `${client.first_name} ${client.last_name}`
      );
      cutCount++;
    }
    console.log(`[CRON] ${cutCount} services cut`);
  });

  // Send payment reminders (daily at 9:00 AM)
  cron.schedule('0 9 * * *', () => {
    const settings = getSettings();
    const reminderDays = parseInt(settings.payment_reminder_days || '3');
    console.log(`[CRON] Sending payment reminders (${reminderDays} days before due)...`);

    const upcoming = db.prepare(`
      SELECT i.*, c.first_name, c.last_name, c.phone
      FROM invoices i JOIN clients c ON i.client_id = c.id
      WHERE i.status = 'pending'
        AND i.due_date BETWEEN date('now') AND date('now', '+' || ? || ' days')
    `).all(String(reminderDays));

    const template = db.prepare("SELECT content FROM message_templates WHERE name = 'payment_reminder'").get();

    for (const inv of upcoming) {
      let message = (template ? template.content : 'Recordatorio: su pago de {monto} vence el {fecha_vencimiento}')
        .replace(/{nombre}/g, `${inv.first_name} ${inv.last_name}`)
        .replace(/{monto}/g, `${settings.currency || '$'}${inv.total.toFixed(2)}`)
        .replace(/{factura}/g, inv.invoice_number)
        .replace(/{fecha_vencimiento}/g, inv.due_date)
        .replace(/{empresa}/g, settings.company_name || 'WISP');

      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, template, status) VALUES (?, ?, ?, ?, ?)').run(
        inv.client_id, inv.phone, message, 'payment_reminder', 'queued'
      );
    }
    console.log(`[CRON] ${upcoming.length} reminders queued`);
  });

  console.log('[CRON] Scheduled jobs initialized');
};
