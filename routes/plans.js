const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const plans = db.prepare(`SELECT p.*, COUNT(c.id) as client_count
      FROM plans p LEFT JOIN clients c ON c.plan_id = p.id
      GROUP BY p.id ORDER BY p.name`).all();
    const settings = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(s => settings[s.key] = s.value);
    res.render('plans/index', { plans, settings });
  });

  router.get('/new', (req, res) => {
    res.render('plans/form', { plan: null });
  });

  router.post('/', (req, res) => {
    const { name, speed_down, speed_up, price, description } = req.body;
    db.prepare('INSERT INTO plans (name, speed_down, speed_up, price, description) VALUES (?, ?, ?, ?, ?)').run(
      name, speed_down, speed_up, parseFloat(price), description || null
    );
    req.session.success = 'Plan creado exitosamente';
    res.redirect('/plans');
  });

  router.get('/:id/edit', (req, res) => {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
    if (!plan) return res.redirect('/plans');
    res.render('plans/form', { plan });
  });

  router.post('/:id', (req, res) => {
    const { name, speed_down, speed_up, price, description, active } = req.body;
    db.prepare('UPDATE plans SET name=?, speed_down=?, speed_up=?, price=?, description=?, active=? WHERE id=?').run(
      name, speed_down, speed_up, parseFloat(price), description || null, active ? 1 : 0, req.params.id
    );
    req.session.success = 'Plan actualizado';
    res.redirect('/plans');
  });

  router.post('/:id/delete', (req, res) => {
    const clients = db.prepare('SELECT COUNT(*) as count FROM clients WHERE plan_id = ?').get(req.params.id);
    if (clients.count > 0) {
      req.session.error = 'No se puede eliminar: hay clientes con este plan';
      return res.redirect('/plans');
    }
    db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
    req.session.success = 'Plan eliminado';
    res.redirect('/plans');
  });

  return router;
};
