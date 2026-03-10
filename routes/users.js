const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = function(db) {
  const router = express.Router();

  // List users
  router.get('/', (req, res) => {
    const users = db.prepare('SELECT id, username, name, role, created_at FROM users ORDER BY id').all();
    res.render('users/index', { users });
  });

  // Create user
  router.post('/', (req, res) => {
    const { username, name, password, role } = req.body;
    if (!username || !name || !password) {
      req.session.error = 'Todos los campos son obligatorios';
      return res.redirect('/users');
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      req.session.error = 'El nombre de usuario ya existe';
      return res.redirect('/users');
    }

    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, name, password, role) VALUES (?, ?, ?, ?)').run(
      username, name, hash, role || 'secretary'
    );
    req.session.success = `Usuario "${name}" creado exitosamente`;
    res.redirect('/users');
  });

  // Update user role
  router.post('/:id/role', (req, res) => {
    const userId = parseInt(req.params.id);
    // Don't let admin change their own role
    if (userId === req.session.user.id) {
      req.session.error = 'No puede cambiar su propio rol';
      return res.redirect('/users');
    }
    const { role } = req.body;
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role || 'secretary', userId);
    req.session.success = 'Rol actualizado';
    res.redirect('/users');
  });

  // Reset password
  router.post('/:id/password', (req, res) => {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 4) {
      req.session.error = 'La contraseña debe tener al menos 4 caracteres';
      return res.redirect('/users');
    }
    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
    req.session.success = 'Contraseña actualizada';
    res.redirect('/users');
  });

  // Delete user
  router.post('/:id/delete', (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === req.session.user.id) {
      req.session.error = 'No puede eliminar su propia cuenta';
      return res.redirect('/users');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    req.session.success = 'Usuario eliminado';
    res.redirect('/users');
  });

  return router;
};
