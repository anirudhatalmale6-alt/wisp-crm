const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // List clients
  router.get('/', (req, res) => {
    const { search, status, plan_id } = req.query;
    let sql = `SELECT c.*, p.name as plan_name, p.price as plan_price, p.speed_down
               FROM clients c LEFT JOIN plans p ON c.plan_id = p.id WHERE 1=1`;
    const params = [];

    if (search) {
      sql += ` AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ? OR c.pppoe_user LIKE ? OR c.ip_address LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (status) { sql += ` AND c.status = ?`; params.push(status); }
    if (plan_id) { sql += ` AND c.plan_id = ?`; params.push(plan_id); }

    sql += ' ORDER BY c.first_name, c.last_name';
    const clients = db.prepare(sql).all(...params);
    const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY name').all();

    res.render('clients/index', { clients, plans, filters: req.query, settings: getSettings() });
  });

  // New client form
  router.get('/new', (req, res) => {
    const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY name').all();
    res.render('clients/form', { client: null, plans, settings: getSettings() });
  });

  // Create client
  router.post('/', (req, res) => {
    const b = req.body;
    db.prepare(`INSERT INTO clients (first_name, last_name, phone, phone2, email, address, city, neighborhood,
      plan_id, connection_type, pppoe_user, pppoe_password, ip_address, mac_address, router_name,
      installation_date, billing_day, status, latitude, longitude, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      b.first_name, b.last_name, b.phone, b.phone2 || null, b.email || null,
      b.address || null, b.city || null, b.neighborhood || null,
      b.plan_id || null, b.connection_type || 'pppoe',
      b.pppoe_user || null, b.pppoe_password || null, b.ip_address || null,
      b.mac_address || null, b.router_name || null,
      b.installation_date || null, b.billing_day || 1, b.status || 'active',
      b.latitude ? parseFloat(b.latitude) : null, b.longitude ? parseFloat(b.longitude) : null,
      b.notes || null
    );
    req.session.success = 'Cliente creado exitosamente';
    res.redirect('/clients');
  });

  // View client
  router.get('/:id', (req, res) => {
    const client = db.prepare(`SELECT c.*, p.name as plan_name, p.price as plan_price, p.speed_down, p.speed_up
      FROM clients c LEFT JOIN plans p ON c.plan_id = p.id WHERE c.id = ?`).get(req.params.id);
    if (!client) return res.redirect('/clients');

    const invoices = db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
    const payments = db.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
    const messages = db.prepare('SELECT * FROM whatsapp_log WHERE client_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
    const cuts = db.prepare('SELECT * FROM service_cuts WHERE client_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.id);

    res.render('clients/show', { client, invoices, payments, messages, cuts, settings: getSettings() });
  });

  // Edit client form
  router.get('/:id/edit', (req, res) => {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
    if (!client) return res.redirect('/clients');
    const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY name').all();
    res.render('clients/form', { client, plans, settings: getSettings() });
  });

  // Update client
  router.post('/:id', (req, res) => {
    const b = req.body;
    db.prepare(`UPDATE clients SET first_name=?, last_name=?, phone=?, phone2=?, email=?, address=?, city=?, neighborhood=?,
      plan_id=?, connection_type=?, pppoe_user=?, pppoe_password=?, ip_address=?, mac_address=?, router_name=?,
      installation_date=?, billing_day=?, status=?, latitude=?, longitude=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      b.first_name, b.last_name, b.phone, b.phone2 || null, b.email || null,
      b.address || null, b.city || null, b.neighborhood || null,
      b.plan_id || null, b.connection_type || 'pppoe',
      b.pppoe_user || null, b.pppoe_password || null, b.ip_address || null,
      b.mac_address || null, b.router_name || null,
      b.installation_date || null, b.billing_day || 1, b.status || 'active',
      b.latitude ? parseFloat(b.latitude) : null, b.longitude ? parseFloat(b.longitude) : null,
      b.notes || null, req.params.id
    );
    req.session.success = 'Cliente actualizado exitosamente';
    res.redirect('/clients/' + req.params.id);
  });

  // Delete client
  router.post('/:id/delete', (req, res) => {
    db.prepare('DELETE FROM whatsapp_log WHERE client_id = ?').run(req.params.id);
    db.prepare('DELETE FROM service_cuts WHERE client_id = ?').run(req.params.id);
    db.prepare('DELETE FROM payments WHERE client_id = ?').run(req.params.id);
    db.prepare('DELETE FROM invoices WHERE client_id = ?').run(req.params.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
    req.session.success = 'Cliente eliminado';
    res.redirect('/clients');
  });

  return router;
};
