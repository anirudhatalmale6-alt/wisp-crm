const express = require('express');
const axios = require('axios');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // Format phone for WhatsApp (add country code if missing)
  const formatPhone = (phone) => {
    if (!phone) return null;
    let clean = phone.replace(/[^0-9]/g, '');
    // If starts with 0, assume local - add country code (Dominican Republic = 1)
    if (clean.startsWith('0')) clean = '1' + clean.substring(1);
    // If less than 10 digits, assume needs country code
    if (clean.length === 10) clean = '1' + clean;
    return clean;
  };

  // Send WhatsApp message via Meta API
  const sendWhatsApp = async (phone, message, clientId = null) => {
    const settings = getSettings();
    if (settings.whatsapp_enabled !== '1') {
      // Log but don't send - WhatsApp not configured
      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, status) VALUES (?, ?, ?, ?)').run(
        clientId, phone, message, 'not_configured'
      );
      return { success: false, reason: 'WhatsApp no configurado' };
    }

    const phoneId = settings.whatsapp_phone_id || process.env.WHATSAPP_PHONE_ID;
    const token = settings.whatsapp_token || process.env.WHATSAPP_TOKEN;

    if (!phoneId || !token) {
      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, status) VALUES (?, ?, ?, ?)').run(
        clientId, phone, message, 'no_credentials'
      );
      return { success: false, reason: 'Credenciales WhatsApp no configuradas' };
    }

    try {
      const formatted = formatPhone(phone);
      await axios.post(
        `https://graph.facebook.com/v17.0/${phoneId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: formatted,
          type: 'text',
          text: { body: message }
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );

      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, status) VALUES (?, ?, ?, ?)').run(
        clientId, phone, message, 'sent'
      );
      return { success: true };
    } catch (err) {
      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, status) VALUES (?, ?, ?, ?)').run(
        clientId, phone, message, 'error'
      );
      return { success: false, reason: err.response?.data?.error?.message || err.message };
    }
  };

  // Message log
  router.get('/', (req, res) => {
    const messages = db.prepare(`SELECT w.*, c.first_name, c.last_name
      FROM whatsapp_log w LEFT JOIN clients c ON w.client_id = c.id
      ORDER BY w.created_at DESC LIMIT 100`).all();
    const templates = db.prepare('SELECT * FROM message_templates ORDER BY category, name').all();
    res.render('whatsapp/index', { messages, templates, settings: getSettings() });
  });

  // Send custom message to a client
  router.post('/send', (req, res) => {
    const { client_id, message } = req.body;
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
    if (!client) {
      req.session.error = 'Cliente no encontrado';
      return res.redirect('/whatsapp');
    }

    sendWhatsApp(client.phone, message, client.id).then(result => {
      if (result.success) {
        req.session.success = 'Mensaje enviado';
      } else {
        req.session.success = 'Mensaje registrado (WhatsApp: ' + result.reason + ')';
      }
      res.redirect(req.body.redirect || '/whatsapp');
    });
  });

  // Send receipt after payment
  router.post('/send-receipt/:paymentId', (req, res) => {
    const payment = db.prepare(`SELECT p.*, c.first_name, c.last_name, c.phone, i.invoice_number
      FROM payments p JOIN clients c ON p.client_id = c.id
      LEFT JOIN invoices i ON p.invoice_id = i.id
      WHERE p.id = ?`).get(req.params.paymentId);

    if (!payment) {
      req.session.error = 'Pago no encontrado';
      return res.redirect('/payments');
    }

    const settings = getSettings();
    const template = db.prepare("SELECT content FROM message_templates WHERE name = 'payment_received'").get();
    let message = (template ? template.content : 'Pago de {monto} recibido. Gracias.')
      .replace(/{nombre}/g, `${payment.first_name} ${payment.last_name}`)
      .replace(/{monto}/g, `${settings.currency || '$'}${payment.amount.toFixed(2)}`)
      .replace(/{factura}/g, payment.invoice_number || 'N/A')
      .replace(/{empresa}/g, settings.company_name || 'WISP');

    sendWhatsApp(payment.phone, message, payment.client_id).then(result => {
      db.prepare('UPDATE payments SET receipt_sent = 1 WHERE id = ?').run(req.params.paymentId);
      req.session.success = result.success ? 'Comprobante enviado por WhatsApp' : 'Comprobante registrado (' + result.reason + ')';
      res.redirect(req.body.redirect || '/payments');
    });
  });

  // Templates management
  router.post('/templates/:id', (req, res) => {
    const { content, active } = req.body;
    db.prepare('UPDATE message_templates SET content = ?, active = ? WHERE id = ?').run(
      content, active ? 1 : 0, req.params.id
    );
    req.session.success = 'Plantilla actualizada';
    res.redirect('/whatsapp');
  });

  // Bulk send reminders
  router.post('/send-reminders', (req, res) => {
    const settings = getSettings();
    const template = db.prepare("SELECT content FROM message_templates WHERE name = 'payment_reminder'").get();

    const overdueInvoices = db.prepare(`
      SELECT i.*, c.first_name, c.last_name, c.phone
      FROM invoices i JOIN clients c ON i.client_id = c.id
      WHERE i.status = 'pending' AND i.due_date <= date('now', '+' || ? || ' days')
    `).all(settings.payment_reminder_days || '3');

    let sent = 0;
    const promises = overdueInvoices.map(inv => {
      let message = (template ? template.content : 'Recordatorio de pago: {monto}')
        .replace(/{nombre}/g, `${inv.first_name} ${inv.last_name}`)
        .replace(/{monto}/g, `${settings.currency || '$'}${inv.total.toFixed(2)}`)
        .replace(/{factura}/g, inv.invoice_number)
        .replace(/{fecha_vencimiento}/g, inv.due_date)
        .replace(/{empresa}/g, settings.company_name || 'WISP');

      return sendWhatsApp(inv.phone, message, inv.client_id).then(r => { if (r.success) sent++; });
    });

    Promise.all(promises).then(() => {
      req.session.success = `${sent} recordatorios enviados de ${overdueInvoices.length} facturas pendientes`;
      res.redirect('/whatsapp');
    });
  });

  // Export sendWhatsApp for use in cron jobs
  router.sendWhatsApp = sendWhatsApp;
  router.formatPhone = formatPhone;

  return router;
};
