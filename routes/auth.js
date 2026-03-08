const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = function(db) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('login', { error: null });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.render('login', { error: 'Usuario o contraseña incorrectos' });
    }
    req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role };
    res.redirect('/dashboard');
  });

  router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  return router;
};
