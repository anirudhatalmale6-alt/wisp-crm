const express = require('express');
const bcrypt = require('bcryptjs');

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
      'auto_cut_enabled', 'payment_reminder_days'];
    const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        update.run(req.body[key], key);
      }
    }
    req.session.success = 'Configuración general actualizada';
    res.redirect('/settings');
  });

  // Update WhatsApp settings
  router.post('/whatsapp', (req, res) => {
    const fields = ['whatsapp_enabled', 'whatsapp_phone_id', 'whatsapp_token'];
    const update = db.prepare('INSERT OR REPLACE INTO settings (key, value, description) VALUES (?, ?, ?)');
    for (const key of fields) {
      if (req.body[key] !== undefined) {
        update.run(key, req.body[key], key.replace(/_/g, ' '));
      }
    }
    req.session.success = 'Configuración WhatsApp actualizada';
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

  // Update message template
  router.post('/templates/:id', (req, res) => {
    const { content } = req.body;
    db.prepare('UPDATE message_templates SET content = ? WHERE id = ?').run(content, req.params.id);
    req.session.success = 'Plantilla actualizada';
    res.redirect('/settings');
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
