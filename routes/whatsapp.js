const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

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
      console.log(`[WhatsApp] Sending to ${formatted} via phone_id ${phoneId}`);
      const resp = await axios.post(
        `https://graph.facebook.com/v22.0/${phoneId}/messages`,
        {
          messaging_product: 'whatsapp',
          to: formatted,
          type: 'text',
          text: { body: message }
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );

      console.log('[WhatsApp] Success:', JSON.stringify(resp.data));
      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, status) VALUES (?, ?, ?, ?)').run(
        clientId, phone, message, 'sent'
      );
      return { success: true };
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      const errCode = err.response?.data?.error?.code || '';
      console.error(`[WhatsApp] Error ${errCode}: ${errMsg}`);
      console.error('[WhatsApp] Full error:', JSON.stringify(err.response?.data || {}));
      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, status) VALUES (?, ?, ?, ?)').run(
        clientId, phone, message, 'failed'
      );
      return { success: false, reason: errMsg };
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

  // Send receipt after payment - opens WhatsApp on the phone with pre-filled message + receipt link
  router.post('/send-receipt/:paymentId', (req, res) => {
    const payment = db.prepare(`SELECT p.*, c.first_name, c.last_name, c.phone, i.invoice_number
      FROM payments p JOIN clients c ON p.client_id = c.id
      LEFT JOIN invoices i ON p.invoice_id = i.id
      WHERE p.id = ?`).get(req.params.paymentId);

    if (!payment) {
      req.session.error = 'Pago no encontrado';
      return res.redirect('/payments');
    }

    if (!payment.phone) {
      req.session.error = 'El cliente no tiene numero de telefono registrado';
      return res.redirect('/payments');
    }

    const settings = getSettings();

    // Generate receipt token if not exists
    let token = payment.receipt_token;
    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE payments SET receipt_token = ? WHERE id = ?').run(token, payment.id);
    }

    // Build receipt URL
    const host = req.get('host');
    const protocol = req.protocol;
    const receiptUrl = `${protocol}://${host}/receipt/${token}`;

    // Get invoice number - try harder to find it
    let invoiceNum = payment.invoice_number;
    if (!invoiceNum && payment.invoice_id) {
      const inv = db.prepare('SELECT invoice_number FROM invoices WHERE id = ?').get(payment.invoice_id);
      invoiceNum = inv ? inv.invoice_number : null;
    }
    if (!invoiceNum) {
      // Find the most recent invoice for this client
      const latestInv = db.prepare("SELECT invoice_number FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 1").get(payment.client_id);
      invoiceNum = latestInv ? latestInv.invoice_number : null;
    }

    // Check remaining debt after this payment
    const currency = settings.currency || 'RD$';
    const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE client_id = ?').get(payment.client_id).total;
    const totalInvoiced = db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE client_id = ? AND status != 'cancelled'").get(payment.client_id).total;
    const remainingDebt = totalInvoiced - totalPaid;

    let statusMsg;
    if (remainingDebt <= 0) {
      statusMsg = 'Su servicio esta al dia.';
    } else {
      statusMsg = `Su balance pendiente es ${currency}${remainingDebt.toFixed(2)}.`;
    }

    let message = `Hola ${payment.first_name} ${payment.last_name}, hemos recibido su pago de ${currency}${payment.amount.toFixed(2)}`;
    if (invoiceNum) message += ` para la factura #${invoiceNum}`;
    message += `. ${statusMsg} Gracias por su pago!`;

    // Add receipt link
    message += `\n\nRecibo: ${receiptUrl}`;

    // Mark as sent
    db.prepare('UPDATE payments SET receipt_sent = 1 WHERE id = ?').run(req.params.paymentId);

    const redirect = req.body.redirect || '/payments';

    // If WhatsApp API is configured, send directly via API
    if (settings.whatsapp_enabled === '1' && settings.whatsapp_phone_id && settings.whatsapp_token) {
      sendWhatsApp(payment.phone, message, payment.client_id).then(result => {
        if (result.success) {
          req.session.success = `Recibo enviado por WhatsApp a ${payment.first_name} ${payment.last_name}`;
        } else {
          req.session.success = `Recibo registrado (WhatsApp: ${result.reason})`;
        }
        res.redirect(redirect);
      });
    } else {
      // Fallback: wa.me link
      db.prepare('INSERT INTO whatsapp_log (client_id, phone, message, status) VALUES (?, ?, ?, ?)').run(
        payment.client_id, payment.phone, message, 'wa_link'
      );
      const phone = formatPhone(payment.phone);
      const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
      res.redirect(waUrl);
    }
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
