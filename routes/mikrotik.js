const express = require('express');
const MikroTik = require('../lib/mikrotik');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  const getMikroTik = () => {
    const settings = getSettings();
    return new MikroTik(settings);
  };

  // MikroTik status page
  router.get('/', async (req, res) => {
    const settings = getSettings();
    const cuts = db.prepare(`SELECT sc.*, c.first_name, c.last_name, c.phone
      FROM service_cuts sc JOIN clients c ON sc.client_id = c.id
      ORDER BY sc.created_at DESC LIMIT 50`).all();

    // Test connection if configured
    let connectionStatus = null;
    const mk = new MikroTik(settings);
    if (mk.isConfigured()) {
      connectionStatus = await mk.testConnection();
    }

    res.render('mikrotik/index', { settings, cuts, connectionStatus });
  });

  // Test MikroTik connection
  router.post('/test', async (req, res) => {
    const mk = getMikroTik();
    if (!mk.isConfigured()) {
      req.session.error = 'MikroTik no está configurado. Ve a Configuración para agregar los datos.';
      return res.redirect('/mikrotik');
    }
    const result = await mk.testConnection();
    if (result.success) {
      req.session.success = `Conexión exitosa: ${result.identity} (RouterOS ${result.version}), Uptime: ${result.uptime}`;
    } else {
      req.session.error = `Error de conexión: ${result.error}`;
    }
    res.redirect('/mikrotik');
  });

  // Manual cut service
  router.post('/cut/:clientId', async (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    const mk = getMikroTik();
    let mikrotikResult = null;

    // Try MikroTik API if configured
    if (mk.isConfigured()) {
      try {
        mikrotikResult = await mk.cutService(client);
      } catch (err) {
        req.session.error = `Error MikroTik: ${err.message}. El cliente fue marcado como suspendido en el sistema pero el corte en MikroTik falló.`;
      }
    }

    // Update database
    db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(client.id);
    db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'cut', ?, 0)").run(
      client.id, req.body.reason || 'Corte manual'
    );

    if (!req.session.error) {
      const mkMsg = mikrotikResult ? ' (MikroTik actualizado)' : ' (solo en sistema, MikroTik no configurado)';
      req.session.success = `Servicio cortado para ${client.first_name} ${client.last_name}${mkMsg}`;
    }
    res.redirect('/clients/' + client.id);
  });

  // Manual reconnect
  router.post('/reconnect/:clientId', async (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
    if (!client) return res.redirect('/clients');

    const mk = getMikroTik();
    let mikrotikResult = null;

    // Try MikroTik API if configured
    if (mk.isConfigured()) {
      try {
        mikrotikResult = await mk.reconnectService(client);
      } catch (err) {
        req.session.error = `Error MikroTik: ${err.message}. El cliente fue reconectado en el sistema pero la reconexión en MikroTik falló.`;
      }
    }

    // Update database
    db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").run(client.id);
    db.prepare("INSERT INTO service_cuts (client_id, action, reason, automatic) VALUES (?, 'reconnect', ?, 0)").run(
      client.id, req.body.reason || 'Reconexión manual'
    );

    if (!req.session.error) {
      const mkMsg = mikrotikResult ? ' (MikroTik actualizado)' : ' (solo en sistema, MikroTik no configurado)';
      req.session.success = `Servicio reconectado para ${client.first_name} ${client.last_name}${mkMsg}`;
    }
    res.redirect('/clients/' + client.id);
  });

  return router;
};
