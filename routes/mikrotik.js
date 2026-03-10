const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // MikroTik status page
  router.get('/', (req, res) => {
    const settings = getSettings();
    const cuts = db.prepare(`SELECT sc.*, c.first_name, c.last_name, c.phone
      FROM service_cuts sc JOIN clients c ON sc.client_id = c.id
      ORDER BY sc.created_at DESC LIMIT 50`).all();

    // Get recent queue items
    const queueItems = db.prepare(`SELECT * FROM mikrotik_queue ORDER BY created_at DESC LIMIT 20`).all();
    const pendingCount = db.prepare(`SELECT COUNT(*) as count FROM mikrotik_queue WHERE status = 'pending'`).get().count;

    res.render('mikrotik/index', { settings, cuts, queueItems, pendingCount });
  });

  // Manual cut service
  router.post('/cut/:clientId', (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    // Update database
    db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(client.id);
    db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'cut', ?, 0)").run(
      client.id, req.body.reason || 'Corte manual'
    );

    // Queue MikroTik action
    db.prepare(`INSERT INTO mikrotik_queue (client_id, action, pppoe_user, ip_address, connection_type, client_name)
      VALUES (?, 'cut', ?, ?, ?, ?)`).run(
      client.id, client.pppoe_user || null, client.ip_address || null,
      client.connection_type || 'pppoe',
      `${client.first_name} ${client.last_name}`
    );

    req.session.success = `Servicio cortado para ${client.first_name} ${client.last_name} (orden enviada al MikroTik)`;
    res.redirect('/clients/' + client.id);
  });

  // Manual reconnect
  router.post('/reconnect/:clientId', (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    // Update database
    db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(client.id);
    db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'reconnect', ?, 0)").run(
      client.id, req.body.reason || 'Reconexión manual'
    );

    // Queue MikroTik action
    db.prepare(`INSERT INTO mikrotik_queue (client_id, action, pppoe_user, ip_address, connection_type, client_name)
      VALUES (?, 'reconnect', ?, ?, ?, ?)`).run(
      client.id, client.pppoe_user || null, client.ip_address || null,
      client.connection_type || 'pppoe',
      `${client.first_name} ${client.last_name}`
    );

    req.session.success = `Servicio reconectado para ${client.first_name} ${client.last_name} (orden enviada al MikroTik)`;
    res.redirect('/clients/' + client.id);
  });

  // ========== API endpoints for MikroTik polling ==========

  // GET /mikrotik/api/pending - MikroTik polls this for pending actions
  router.get('/api/pending', (req, res) => {
    const actions = db.prepare(`SELECT id, action, pppoe_user, ip_address, connection_type, client_name
      FROM mikrotik_queue WHERE status = 'pending' ORDER BY created_at ASC`).all();
    res.json({ actions });
  });

  // POST /mikrotik/api/confirm - MikroTik confirms action was executed
  router.post('/api/confirm', (req, res) => {
    const { id, result } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing action id' });

    db.prepare(`UPDATE mikrotik_queue SET status = 'done', result = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      result || 'OK', id
    );
    res.json({ success: true });
  });

  // POST /mikrotik/api/confirm-batch - Confirm multiple actions at once
  router.post('/api/confirm-batch', (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Missing ids array' });

    const stmt = db.prepare(`UPDATE mikrotik_queue SET status = 'done', result = 'OK', executed_at = CURRENT_TIMESTAMP WHERE id = ?`);
    const transaction = db.transaction(() => {
      for (const id of ids) { stmt.run(id); }
    });
    transaction();
    res.json({ success: true, confirmed: ids.length });
  });

  // GET /mikrotik/api/status - Simple health check for the script
  router.get('/api/status', (req, res) => {
    const pending = db.prepare(`SELECT COUNT(*) as count FROM mikrotik_queue WHERE status = 'pending'`).get().count;
    res.json({ online: true, pending });
  });

  return router;
};
