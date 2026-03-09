const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const path = require('path');

const upload = multer({ dest: '/tmp/wisp-uploads/' });

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // Calculate balance for a client: total paid - total invoiced (pending/overdue)
  const getClientBalance = (clientId) => {
    const invoiced = db.prepare(`SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE client_id = ? AND status IN ('pending', 'overdue')`).get(clientId);
    const paid = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE client_id = ?`).get(clientId);
    const totalInvoiced = db.prepare(`SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE client_id = ? AND status != 'cancelled'`).get(clientId);
    return {
      pending: invoiced.total,
      totalPaid: paid.total,
      totalInvoiced: totalInvoiced.total,
      balance: paid.total - totalInvoiced.total // positive = credit, negative = debt
    };
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

    // Add balance info to each client
    clients.forEach(c => {
      const bal = getClientBalance(c.id);
      c.balance = bal.balance;
      c.pending = bal.pending;
    });

    res.render('clients/index', { clients, plans, filters: req.query, settings: getSettings() });
  });

  // Export clients to Excel
  router.get('/export', (req, res) => {
    const clients = db.prepare(`SELECT c.*, p.name as plan_name FROM clients c LEFT JOIN plans p ON c.plan_id = p.id ORDER BY c.first_name, c.last_name`).all();

    const data = clients.map(c => ({
      'Nombre': c.first_name,
      'Apellido': c.last_name,
      'Teléfono': c.phone,
      'Teléfono 2': c.phone2 || '',
      'Email': c.email || '',
      'Dirección': c.address || '',
      'Ciudad': c.city || '',
      'Sector': c.neighborhood || '',
      'Plan': c.plan_name || '',
      'Tipo Conexión': c.connection_type || '',
      'Usuario PPPoE': c.pppoe_user || '',
      'Contraseña PPPoE': c.pppoe_password || '',
      'IP': c.ip_address || '',
      'MAC': c.mac_address || '',
      'Router': c.router_name || '',
      'Fecha Instalación': c.installation_date || '',
      'Día Cobro': c.billing_day || '',
      'Estado': c.status || '',
      'Latitud': c.latitude || '',
      'Longitud': c.longitude || '',
      'Notas': c.notes || ''
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);

    // Auto-width columns
    const colWidths = Object.keys(data[0] || {}).map(key => ({ wch: Math.max(key.length, 15) }));
    ws['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename=clientes_${date}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  });

  // Import clients from Excel
  router.post('/import', upload.single('file'), (req, res) => {
    if (!req.file) {
      req.session.error = 'No se seleccionó ningún archivo';
      return res.redirect('/clients');
    }

    try {
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws);

      const plans = db.prepare('SELECT id, name FROM plans').all();
      const planMap = {};
      plans.forEach(p => { planMap[p.name.toLowerCase()] = p.id; });

      const insert = db.prepare(`INSERT INTO clients (first_name, last_name, phone, phone2, email, address, city, neighborhood,
        plan_id, connection_type, pppoe_user, pppoe_password, ip_address, mac_address, router_name,
        installation_date, billing_day, status, latitude, longitude, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

      let imported = 0;
      let skipped = 0;

      const transaction = db.transaction(() => {
        for (const row of rows) {
          const firstName = (row['Nombre'] || '').toString().trim();
          const lastName = (row['Apellido'] || '').toString().trim();
          const phone = (row['Teléfono'] || row['Telefono'] || '').toString().trim();

          if (!firstName || !phone) {
            skipped++;
            continue;
          }

          const planName = (row['Plan'] || '').toString().trim().toLowerCase();
          const planId = planMap[planName] || null;

          insert.run(
            firstName,
            lastName,
            phone,
            (row['Teléfono 2'] || row['Telefono 2'] || '').toString().trim() || null,
            (row['Email'] || '').toString().trim() || null,
            (row['Dirección'] || row['Direccion'] || '').toString().trim() || null,
            (row['Ciudad'] || '').toString().trim() || null,
            (row['Sector'] || '').toString().trim() || null,
            planId,
            (row['Tipo Conexión'] || row['Tipo Conexion'] || 'pppoe').toString().trim(),
            (row['Usuario PPPoE'] || row['Usuario PPPOE'] || '').toString().trim() || null,
            (row['Contraseña PPPoE'] || row['Contrasena PPPoE'] || '').toString().trim() || null,
            (row['IP'] || '').toString().trim() || null,
            (row['MAC'] || '').toString().trim() || null,
            (row['Router'] || '').toString().trim() || null,
            (row['Fecha Instalación'] || row['Fecha Instalacion'] || '').toString().trim() || null,
            parseInt(row['Día Cobro'] || row['Dia Cobro'] || '1') || 1,
            (row['Estado'] || 'active').toString().trim(),
            row['Latitud'] ? parseFloat(row['Latitud']) : null,
            row['Longitud'] ? parseFloat(row['Longitud']) : null,
            (row['Notas'] || '').toString().trim() || null
          );
          imported++;
        }
      });

      transaction();

      req.session.success = `Se importaron ${imported} cliente${imported !== 1 ? 's' : ''} exitosamente` + (skipped > 0 ? ` (${skipped} omitido${skipped !== 1 ? 's' : ''} por datos incompletos)` : '');
    } catch (err) {
      req.session.error = 'Error al importar: ' + err.message;
    }

    res.redirect('/clients');
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
    const balance = getClientBalance(req.params.id);

    res.render('clients/show', { client, invoices, payments, messages, cuts, balance, settings: getSettings() });
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
