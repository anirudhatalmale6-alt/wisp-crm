require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new Database(path.join(__dirname, 'data', 'wisp.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize database
const initDB = require('./db/init');
initDB(db);

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'wisp-crm-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

// Make session user available to all views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.session.success || null;
  res.locals.error = req.session.error || null;
  delete req.session.success;
  delete req.session.error;
  next();
});

// Routes
const authRoutes = require('./routes/auth')(db);
const dashboardRoutes = require('./routes/dashboard')(db);
const clientRoutes = require('./routes/clients')(db);
const planRoutes = require('./routes/plans')(db);
const invoiceRoutes = require('./routes/invoices')(db);
const paymentRoutes = require('./routes/payments')(db);
const whatsappRoutes = require('./routes/whatsapp')(db);
const settingsRoutes = require('./routes/settings')(db);
const mikrotikRoutes = require('./routes/mikrotik')(db);

app.use('/', authRoutes);
app.use('/dashboard', requireAuth, dashboardRoutes);
app.use('/clients', requireAuth, clientRoutes);
app.use('/plans', requireAuth, planRoutes);
app.use('/invoices', requireAuth, invoiceRoutes);
app.use('/payments', requireAuth, paymentRoutes);
app.use('/whatsapp', requireAuth, whatsappRoutes);
app.use('/settings', requireAuth, settingsRoutes);
// MikroTik API endpoints (no auth - called by MikroTik router)
app.use('/mikrotik/api', mikrotikRoutes);
// MikroTik web pages (require auth)
app.use('/mikrotik', requireAuth, mikrotikRoutes);

// Redirect root to dashboard
app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

// Cron jobs for automatic billing and notifications
const cronJobs = require('./cron/jobs')(db);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WISP CRM running on http://localhost:${PORT}`);
});
