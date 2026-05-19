const cron = require('node-cron');

module.exports = function(db) {
  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // Auto-generate invoices daily at 6:00 AM
  // Catches up missed billing days: generates for any billing day <= today that has no invoice yet
  cron.schedule('0 6 * * *', () => {
    const now = new Date();
    const today = now.getDate();
    const year = now.getFullYear();
    const month = now.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();

    console.log(`[CRON] Checking invoice generation (day ${today}, catch-up enabled)...`);
    const settings = getSettings();
    const taxRate = parseFloat(settings.tax_rate || '0') / 100;

    const activeServices = db.prepare(`SELECT cs.*, p.price, c.first_name, c.last_name FROM client_services cs
      JOIN plans p ON cs.plan_id = p.id
      JOIN clients c ON cs.client_id = c.id
      WHERE cs.status = 'active' AND c.status != 'inactive'`).all();

    let count = 0;
    const prefix = `FAC-${year}${String(month + 1).padStart(2, '0')}`;

    // Find the highest existing sequence number for this month to avoid duplicates
    const lastInv = db.prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1").get(prefix + '%');
    let seq = 0;
    if (lastInv) {
      const parts = lastInv.invoice_number.split('-');
      seq = parseInt(parts[2] || '0');
    }

    for (const svc of activeServices) {
      const billingDay = svc.billing_day || 1;
      const effectiveBillingDay = Math.min(billingDay, lastDay);

      // Generate if billing day has passed (or is today) and no invoice exists yet
      if (effectiveBillingDay > today) continue;

      const periodStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const periodEnd = `${year}-${String(month + 1).padStart(2, '0')}-${lastDay}`;
      const dueDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(effectiveBillingDay).padStart(2, '0')}`;

      const existing = db.prepare('SELECT id FROM invoices WHERE service_id = ? AND period_start = ?').get(svc.id, periodStart);
      if (existing) continue;

      let amount = svc.price;
      const prevInvoice = db.prepare('SELECT id FROM invoices WHERE service_id = ?').get(svc.id);

      if (!prevInvoice && svc.installation_date) {
        const instDate = new Date(svc.installation_date);
        const msPerDay = 24 * 60 * 60 * 1000;
        const daysUsed = Math.round((now.getTime() - instDate.getTime()) / msPerDay);

        if (daysUsed > 0 && daysUsed < lastDay) {
          amount = Math.round((svc.price / lastDay) * daysUsed * 100) / 100;
          console.log(`[CRON] Proration: ${svc.first_name} ${svc.last_name} - ${daysUsed} dias de ${lastDay} = ${amount}`);
        }
      }

      const tax = Math.round(amount * taxRate * 100) / 100;
      const total = Math.round((amount + tax) * 100) / 100;
      const invoiceNum = `${prefix}-${String(++seq).padStart(4, '0')}`;

      try {
        db.prepare(`INSERT INTO invoices (client_id, service_id, invoice_number, period_start, period_end, amount, tax, total, due_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          svc.client_id, svc.id, invoiceNum, periodStart, periodEnd, amount, tax, total, dueDate
        );
        count++;
        console.log(`[CRON] Invoice ${invoiceNum}: ${svc.first_name} ${svc.last_name} - ${total}`);
      } catch (err) {
        console.error(`[CRON] Error generating invoice for ${svc.first_name} ${svc.last_name}: ${err.message}`);
      }
    }
    console.log(`[CRON] ${count} invoices generated`);
  });

  // Auto-cut service for overdue services (daily at 8:00 AM)
  cron.schedule('0 8 * * *', () => {
    const settings = getSettings();
    if (settings.auto_cut_enabled !== '1') return;

    const graceDays = parseInt(settings.grace_days || '5');
    console.log(`[CRON] Checking for overdue services (grace: ${graceDays} days)...`);

    const overdueServices = db.prepare(`
      SELECT DISTINCT cs.id as service_id, cs.client_id, cs.connection_type, cs.pppoe_user, cs.ip_address,
        c.first_name, c.last_name
      FROM client_services cs
      JOIN clients c ON cs.client_id = c.id
      JOIN invoices i ON i.service_id = cs.id
      WHERE cs.status = 'active'
        AND i.status = 'pending'
        AND i.due_date <= date('now', '-' || ? || ' days')
    `).all(String(graceDays));

    let cutCount = 0;

    for (const svc of overdueServices) {
      db.prepare("UPDATE client_services SET status = 'suspended' WHERE id = ?").run(svc.service_id);
      db.prepare("INSERT INTO service_cuts (client_id, service_id, action, reason, automatic) VALUES (?, ?, 'cut', 'Corte automatico por mora', 1)").run(svc.client_id, svc.service_id);

      // Check if ALL services of this client are now suspended
      const activeCount = db.prepare("SELECT COUNT(*) as count FROM client_services WHERE client_id = ? AND status = 'active'").get(svc.client_id).count;
      if (activeCount === 0) {
        db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(svc.client_id);
      }

      // Queue MikroTik action
      db.prepare(`INSERT INTO mikrotik_queue (client_id, service_id, action, pppoe_user, ip_address, connection_type, client_name)
        VALUES (?, ?, 'cut', ?, ?, ?, ?)`).run(
        svc.client_id, svc.service_id, svc.pppoe_user || null, svc.ip_address || null,
        svc.connection_type || 'pppoe',
        `${svc.first_name} ${svc.last_name}`
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
