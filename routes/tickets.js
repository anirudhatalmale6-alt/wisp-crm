const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  // List tickets
  router.get('/', (req, res) => {
    const { status, priority, client_id } = req.query;
    let sql = `SELECT t.*, c.first_name, c.last_name, c.phone
               FROM tickets t LEFT JOIN clients c ON t.client_id = c.id WHERE 1=1`;
    const params = [];

    if (status) { sql += ` AND t.status = ?`; params.push(status); }
    if (priority) { sql += ` AND t.priority = ?`; params.push(priority); }
    if (client_id) { sql += ` AND t.client_id = ?`; params.push(client_id); }

    sql += ' ORDER BY CASE t.status WHEN \'abierto\' THEN 1 WHEN \'en_progreso\' THEN 2 ELSE 3 END, CASE t.priority WHEN \'alta\' THEN 1 WHEN \'media\' THEN 2 ELSE 3 END, t.created_at DESC';
    const tickets = db.prepare(sql).all(...params);

    const counts = {
      abierto: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'abierto'").get().c,
      en_progreso: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'en_progreso'").get().c,
      resuelto: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'resuelto'").get().c
    };

    res.render('tickets/index', { tickets, filters: req.query, counts });
  });

  // New ticket form
  router.get('/new', (req, res) => {
    const clients = db.prepare(`SELECT id, first_name, last_name, phone FROM clients WHERE status != 'inactive' ORDER BY first_name, last_name`).all();
    res.render('tickets/form', { ticket: null, clients, preselect_client: req.query.client_id || '' });
  });

  // Create ticket
  router.post('/', (req, res) => {
    const { client_id, title, description, priority, assigned_to } = req.body;
    if (!title) {
      req.session.error = 'El titulo del ticket es obligatorio';
      return res.redirect('/tickets/new');
    }

    db.prepare(`INSERT INTO tickets (client_id, title, description, priority, assigned_to)
      VALUES (?, ?, ?, ?, ?)`).run(
      client_id || null, title, description || null, priority || 'media', assigned_to || null
    );

    req.session.success = 'Ticket creado exitosamente';
    res.redirect('/tickets');
  });

  // View single ticket
  router.get('/:id', (req, res) => {
    const ticket = db.prepare(`SELECT t.*, c.first_name, c.last_name, c.phone, c.address
      FROM tickets t LEFT JOIN clients c ON t.client_id = c.id
      WHERE t.id = ?`).get(req.params.id);
    if (!ticket) return res.redirect('/tickets');
    res.render('tickets/show', { ticket });
  });

  // Edit ticket form
  router.get('/:id/edit', (req, res) => {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
    if (!ticket) return res.redirect('/tickets');
    const clients = db.prepare(`SELECT id, first_name, last_name, phone FROM clients WHERE status != 'inactive' ORDER BY first_name, last_name`).all();
    res.render('tickets/form', { ticket, clients, preselect_client: ticket.client_id || '' });
  });

  // Update ticket
  router.post('/:id', (req, res) => {
    const { client_id, title, description, priority, assigned_to, status, resolution_notes } = req.body;
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
    if (!ticket) return res.redirect('/tickets');

    const resolvedAt = (status === 'resuelto' && ticket.status !== 'resuelto')
      ? new Date().toISOString() : ticket.resolved_at;

    db.prepare(`UPDATE tickets SET client_id = ?, title = ?, description = ?, priority = ?,
      assigned_to = ?, status = ?, resolution_notes = ?, resolved_at = ? WHERE id = ?`).run(
      client_id || null, title, description || null, priority || 'media',
      assigned_to || null, status || ticket.status, resolution_notes || null, resolvedAt, req.params.id
    );

    req.session.success = 'Ticket actualizado';
    res.redirect('/tickets/' + req.params.id);
  });

  // Quick status change
  router.post('/:id/status', (req, res) => {
    const { status } = req.body;
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
    if (!ticket) return res.redirect('/tickets');

    const resolvedAt = (status === 'resuelto' && ticket.status !== 'resuelto')
      ? new Date().toISOString() : ticket.resolved_at;

    db.prepare('UPDATE tickets SET status = ?, resolved_at = ? WHERE id = ?').run(
      status, resolvedAt, req.params.id
    );

    req.session.success = status === 'resuelto' ? 'Ticket resuelto' : 'Estado actualizado';
    res.redirect(req.body.redirect || '/tickets');
  });

  // Delete ticket
  router.post('/:id/delete', (req, res) => {
    db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id);
    req.session.success = 'Ticket eliminado';
    res.redirect('/tickets');
  });

  return router;
};
