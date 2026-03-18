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

  // Manual cut service (admin only) — supports per-service via ?service_id=
  router.post('/cut/:clientId', (req, res) => {
    if (req.session.user.role !== 'admin') {
      req.session.error = 'No tiene permisos para cortar servicio';
      return res.redirect('/clients');
    }
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    const serviceId = req.query.service_id || req.body.service_id;
    if (serviceId) {
      // Cut specific service
      const svc = db.prepare('SELECT * FROM client_services WHERE id = ? AND client_id = ?').get(serviceId, client.id);
      if (!svc) return res.redirect('/clients/' + client.id);

      db.prepare("UPDATE client_services SET status = 'suspended' WHERE id = ?").run(svc.id);
      db.prepare("INSERT INTO service_cuts (client_id, service_id, action, reason, automatic) VALUES (?, ?, 'cut', ?, 0)").run(
        client.id, svc.id, req.body.reason || 'Corte manual'
      );

      // If all services suspended, suspend client too
      const activeCount = db.prepare("SELECT COUNT(*) as count FROM client_services WHERE client_id = ? AND status = 'active'").get(client.id).count;
      if (activeCount === 0) {
        db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(client.id);
      }

      db.prepare(`INSERT INTO mikrotik_queue (client_id, service_id, action, pppoe_user, ip_address, connection_type, client_name)
        VALUES (?, ?, 'cut', ?, ?, ?, ?)`).run(
        client.id, svc.id, svc.pppoe_user || null, svc.ip_address || null,
        svc.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
      );
    } else {
      // Cut all services (legacy behavior)
      db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(client.id);
      db.prepare("UPDATE client_services SET status = 'suspended' WHERE client_id = ? AND status = 'active'").run(client.id);
      db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'cut', ?, 0)").run(
        client.id, req.body.reason || 'Corte manual'
      );

      const services = db.prepare('SELECT * FROM client_services WHERE client_id = ?').all(client.id);
      for (const svc of services) {
        db.prepare(`INSERT INTO mikrotik_queue (client_id, service_id, action, pppoe_user, ip_address, connection_type, client_name)
          VALUES (?, ?, 'cut', ?, ?, ?, ?)`).run(
          client.id, svc.id, svc.pppoe_user || null, svc.ip_address || null,
          svc.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
        );
      }
      // Fallback: also queue from client record if no services exist
      if (services.length === 0) {
        db.prepare(`INSERT INTO mikrotik_queue (client_id, action, pppoe_user, ip_address, connection_type, client_name)
          VALUES (?, 'cut', ?, ?, ?, ?)`).run(
          client.id, client.pppoe_user || null, client.ip_address || null,
          client.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
        );
      }
    }

    req.session.success = `Servicio cortado para ${client.first_name} ${client.last_name} (orden enviada al MikroTik)`;
    res.redirect('/clients/' + client.id);
  });

  // Manual reconnect (admin only) — supports per-service via ?service_id=
  router.post('/reconnect/:clientId', (req, res) => {
    if (req.session.user.role !== 'admin') {
      req.session.error = 'No tiene permisos para reconectar servicio';
      return res.redirect('/clients');
    }
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    const serviceId = req.query.service_id || req.body.service_id;
    if (serviceId) {
      // Reconnect specific service
      const svc = db.prepare('SELECT * FROM client_services WHERE id = ? AND client_id = ?').get(serviceId, client.id);
      if (!svc) return res.redirect('/clients/' + client.id);

      db.prepare("UPDATE client_services SET status = 'active' WHERE id = ?").run(svc.id);
      db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(client.id);
      db.prepare("INSERT INTO service_cuts (client_id, service_id, action, reason, automatic) VALUES (?, ?, 'reconnect', ?, 0)").run(
        client.id, svc.id, req.body.reason || 'Reconexión manual'
      );

      db.prepare(`INSERT INTO mikrotik_queue (client_id, service_id, action, pppoe_user, ip_address, connection_type, client_name)
        VALUES (?, ?, 'reconnect', ?, ?, ?, ?)`).run(
        client.id, svc.id, svc.pppoe_user || null, svc.ip_address || null,
        svc.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
      );
    } else {
      // Reconnect all services (legacy behavior)
      db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(client.id);
      db.prepare("UPDATE client_services SET status = 'active' WHERE client_id = ? AND status = 'suspended'").run(client.id);
      db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'reconnect', ?, 0)").run(
        client.id, req.body.reason || 'Reconexión manual'
      );

      const services = db.prepare('SELECT * FROM client_services WHERE client_id = ?').all(client.id);
      for (const svc of services) {
        db.prepare(`INSERT INTO mikrotik_queue (client_id, service_id, action, pppoe_user, ip_address, connection_type, client_name)
          VALUES (?, ?, 'reconnect', ?, ?, ?, ?)`).run(
          client.id, svc.id, svc.pppoe_user || null, svc.ip_address || null,
          svc.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
        );
      }
      if (services.length === 0) {
        db.prepare(`INSERT INTO mikrotik_queue (client_id, action, pppoe_user, ip_address, connection_type, client_name)
          VALUES (?, 'reconnect', ?, ?, ?, ?)`).run(
          client.id, client.pppoe_user || null, client.ip_address || null,
          client.connection_type || 'pppoe', `${client.first_name} ${client.last_name}`
        );
      }
    }

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

  // GET /mikrotik/api/script - Returns a .rsc script that MikroTik can directly import
  router.get('/api/script', (req, res) => {
    const actions = db.prepare(`SELECT id, action, pppoe_user, ip_address, connection_type, client_name
      FROM mikrotik_queue WHERE status = 'pending' ORDER BY created_at ASC`).all();

    if (actions.length === 0) {
      res.type('text/plain').send('# No hay acciones pendientes');
      return;
    }

    const settings = getSettings();
    const serverUrl = `http://192.168.25.3:3000`;
    let script = '# CRM Auto-Sync Script\n';

    for (const a of actions) {
      script += `# ${a.action} - ${a.client_name}\n`;

      if (a.action === 'cut') {
        if (a.connection_type === 'pppoe' && a.pppoe_user) {
          script += `:do {/ppp secret set [find name="${a.pppoe_user}"] disabled=yes} on-error={}\n`;
          script += `:do {/ppp active remove [find name="${a.pppoe_user}"]} on-error={}\n`;
        }
        if (a.ip_address && a.connection_type !== 'pppoe') {
          script += `:do {/ip firewall address-list add list=MOROSO address=${a.ip_address} comment="${a.client_name} - Corte"} on-error={}\n`;
        }
      } else if (a.action === 'reconnect') {
        if (a.connection_type === 'pppoe' && a.pppoe_user) {
          script += `:do {/ppp secret set [find name="${a.pppoe_user}"] disabled=no} on-error={}\n`;
        }
        if (a.ip_address) {
          script += `:do {/ip firewall address-list remove [find list=MOROSO address="${a.ip_address}"]} on-error={}\n`;
        }
      }

      // Mark as done
      db.prepare(`UPDATE mikrotik_queue SET status = 'done', result = 'OK', executed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(a.id);
    }

    script += `# ${actions.length} acciones procesadas\n`;
    res.type('text/plain').send(script);
  });

  return router;
};
