const express = require('express');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

module.exports = function(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const settings = {};
    db.prepare('SELECT key, value, description FROM settings').all().forEach(s => {
      settings[s.key] = { value: s.value, description: s.description };
    });
    const templates = db.prepare('SELECT * FROM message_templates ORDER BY category, name').all();
    res.render('settings/index', { settings, templates });
  });

  // Update general settings
  router.post('/general', (req, res) => {
    const fields = ['company_name', 'company_phone', 'currency', 'tax_rate', 'grace_days',
      'payment_reminder_days'];
    const checkboxFields = ['auto_cut_enabled'];
    const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        update.run(req.body[key], key);
      }
    }
    // Checkboxes: if not in body, value is '0'; if in body, value is '1'
    for (const key of checkboxFields) {
      update.run(req.body[key] ? '1' : '0', key);
    }
    req.session.success = 'Configuración general actualizada';
    res.redirect('/settings');
  });

  // Update WhatsApp settings
  router.post('/whatsapp', (req, res) => {
    const fields = ['whatsapp_phone_id', 'whatsapp_token'];
    const update = db.prepare('INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)');
    // Checkbox: unchecked = not in body
    update.run('whatsapp_enabled', req.body.whatsapp_enabled ? '1' : '0', 'whatsapp enabled');
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        update.run(key, req.body[key], key.replace(/_/g, ' '));
      }
    }
    req.session.success = 'Configuracion WhatsApp actualizada';
    res.redirect('/settings');
  });

  // Update MikroTik settings
  router.post('/mikrotik', (req, res) => {
    const fields = ['mikrotik_host', 'mikrotik_port', 'mikrotik_user', 'mikrotik_pass'];
    const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        update.run(req.body[key], key);
      }
    }
    req.session.success = 'Configuración MikroTik actualizada';
    res.redirect('/settings');
  });

  // Update OLT settings
  router.post('/olt', (req, res) => {
    const fields = ['olt_host', 'olt_port', 'olt_user', 'olt_pass', 'olt_model', 'snmp_community', 'snmp_write_community', 'olt_web_user', 'olt_web_pass'];
    const update = db.prepare('INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)');
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        update.run(key, req.body[key], key.replace(/_/g, ' '));
      }
    }
    req.session.success = 'Configuracion OLT actualizada';
    res.redirect('/settings');
  });

  // Update message template
  router.post('/templates/:id', (req, res) => {
    const { content } = req.body;
    db.prepare('UPDATE message_templates SET content = ? WHERE id = ?').run(content, req.params.id);
    req.session.success = 'Plantilla actualizada';
    res.redirect('/settings');
  });

  // ===== Backup / Export =====

  // Download full database backup (.db file) - complete restorable snapshot
  router.get('/backup/database', async (req, res) => {
    try {
      const dir = '/tmp/wisp-backups';
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fname = `wisp-backup-${stamp}.db`;
      const dest = path.join(dir, fname);
      // better-sqlite3 online backup = consistent snapshot even while running
      await db.backup(dest);
      res.download(dest, fname, () => { fs.unlink(dest, () => {}); });
    } catch (e) {
      req.session.error = 'Error al generar el respaldo: ' + e.message;
      res.redirect('/settings');
    }
  });

  // Download clients-with-debt report (Excel)
  router.get('/backup/debts', (req, res) => {
    const currency = (() => {
      const r = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get();
      return r ? r.value : '$';
    })();

    const clients = db.prepare(`
      SELECT c.id, c.first_name, c.last_name, c.phone, c.phone2, c.cedula, c.address,
             c.status, c.pppoe_user, p.name as plan_name,
             COALESCE((SELECT SUM(total) FROM invoices WHERE client_id = c.id AND status != 'cancelled'), 0) as invoiced,
             COALESCE((SELECT SUM(amount) FROM payments WHERE client_id = c.id), 0) as paid
      FROM clients c LEFT JOIN plans p ON c.plan_id = p.id
      ORDER BY c.first_name, c.last_name
    `).all();

    const data = clients.map(c => {
      const bal = Math.round((c.invoiced - c.paid) * 100) / 100;
      return {
        'Nombre': c.first_name,
        'Apellido': c.last_name,
        'Telefono': c.phone || '',
        'Telefono 2': c.phone2 || '',
        'Cedula': c.cedula || '',
        'Direccion': c.address || '',
        'Usuario PPPoE': c.pppoe_user || '',
        'Plan': c.plan_name || '',
        'Estado': c.status === 'active' ? 'Activo' : c.status === 'suspended' ? 'Suspendido' : (c.status || ''),
        'Total Facturado': Math.round(c.invoiced * 100) / 100,
        'Total Pagado': Math.round(c.paid * 100) / 100,
        'Deuda': bal > 0 ? bal : 0,
        'Saldo a Favor': bal < 0 ? Math.abs(bal) : 0
      };
    });

    const totalDebt = data.reduce((s, r) => s + r['Deuda'], 0);
    data.push({});
    data.push({ 'Nombre': 'TOTAL DEUDA', 'Deuda': Math.round(totalDebt * 100) / 100 });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = Object.keys(data[0] || { a: 1 }).map(k => ({ wch: Math.max(k.length, 14) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Clientes y Deudas');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename=clientes_deudas_${date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  // Change password
  router.post('/password', (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

    if (!bcrypt.compareSync(current_password, user.password)) {
      req.session.error = 'Contraseña actual incorrecta';
      return res.redirect('/settings');
    }
    if (new_password !== confirm_password) {
      req.session.error = 'Las contraseñas no coinciden';
      return res.redirect('/settings');
    }

    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
    req.session.success = 'Contraseña actualizada';
    res.redirect('/settings');
  });

  return router;
};
