const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // MikroTik status page (placeholder - will be implemented in Phase 2)
  router.get('/', (req, res) => {
    const settings = getSettings();
    const cuts = db.prepare(`SELECT sc.*, c.first_name, c.last_name, c.phone
      FROM service_cuts sc JOIN clients c ON sc.client_id = c.id
      ORDER BY sc.created_at DESC LIMIT 50`).all();
    res.render('mikrotik/index', { settings, cuts });
  });

  // Manual cut service
  router.post('/cut/:clientId', (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(client.id);
    db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'cut', ?, 0)").run(
      client.id, req.body.reason || 'Corte manual'
    );

    // TODO Phase 2: Send MikroTik API command to disable PPPoE/queue
    req.session.success = `Servicio cortado para ${client.first_name} ${client.last_name}`;
    res.redirect('/clients/' + client.id);
  });

  // Manual reconnect
  router.post('/reconnect/:clientId', (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(client.id);
    db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'reconnect', ?, 0)").run(
      client.id, req.body.reason || 'Reconexión manual'
    );

    // TODO Phase 2: Send MikroTik API command to enable PPPoE/queue
    req.session.success = `Servicio reconectado para ${client.first_name} ${client.last_name}`;
    res.redirect('/clients/' + client.id);
  });

  return router;
};
