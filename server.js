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

// Admin-only middleware
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  req.session.error = 'No tiene permisos para realizar esta acción';
  res.redirect('/dashboard');
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
const usersRoutes = require('./routes/users')(db);
const onuRoutes = require('./routes/onu')(db);

// Public receipt page (no auth required - accessed by clients via WhatsApp link)
app.get('/receipt/:token', (req, res) => {
  const payment = db.prepare(`SELECT p.*, c.first_name, c.last_name, c.phone, c.address,
           i.invoice_number, i.period_start, i.period_end,
           COALESCE(pl.name, '') as plan_name, COALESCE(pl.speed_down, '') as speed_down
    FROM payments p
    JOIN clients c ON p.client_id = c.id
    LEFT JOIN invoices i ON p.invoice_id = i.id
    LEFT JOIN plans pl ON pl.id = c.plan_id
    WHERE p.receipt_token = ?`).get(req.params.token);

  if (!payment) {
    return res.status(404).send('<h1>Recibo no encontrado</h1>');
  }

  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => settings[r.key] = r.value);

  // Find invoice number if not directly linked
  let invoiceNum = payment.invoice_number;
  if (!invoiceNum) {
    const latestInv = db.prepare("SELECT invoice_number FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 1").get(payment.client_id);
    invoiceNum = latestInv ? latestInv.invoice_number : '';
  }
  payment.invoice_num = invoiceNum;

  // Calculate remaining debt
  const currency = settings.currency || 'RD$';
  const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE client_id = ?').get(payment.client_id).total;
  const totalInvoiced = db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE client_id = ? AND status != 'cancelled'").get(payment.client_id).total;
  const remainingDebt = totalInvoiced - totalPaid;

  res.render('payments/receipt-public', { payment, settings, remainingDebt, currency });
});

app.use('/', authRoutes);
app.use('/dashboard', requireAuth, dashboardRoutes);
app.use('/clients', requireAuth, clientRoutes);
app.use('/plans', requireAuth, planRoutes);
app.use('/invoices', requireAuth, invoiceRoutes);
app.use('/payments', requireAuth, paymentRoutes);
app.use('/whatsapp', requireAuth, whatsappRoutes);
app.use('/settings', requireAuth, requireAdmin, settingsRoutes);
app.use('/users', requireAuth, requireAdmin, usersRoutes);
app.use('/onu', requireAuth, onuRoutes);

// Client map
app.get('/map', requireAuth, (req, res) => {
  const clients = db.prepare(`SELECT c.*, COALESCE(p.name, '') as plan_name
    FROM clients c LEFT JOIN plans p ON c.plan_id = p.id
    ORDER BY c.first_name, c.last_name`).all();
  res.render('map', { clients, currentPage: 'map' });
});

// MikroTik routes - API endpoints skip auth, web pages require auth
app.use('/mikrotik', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  requireAuth(req, res, next);
}, mikrotikRoutes);

// Redirect root to dashboard
// API: Resolve shortened Google Maps URLs
app.post('/api/resolve-maps-url', requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.json({ error: 'No URL provided' });
    const response = await axios.get(url, { maxRedirects: 5, timeout: 5000 });
    res.json({ url: response.request.res.responseUrl || response.config.url || url });
  } catch (e) {
    // Even on error, axios may have followed redirects
    if (e.response && e.request && e.request.res && e.request.res.responseUrl) {
      return res.json({ url: e.request.res.responseUrl });
    }
    res.json({ error: 'Could not resolve URL' });
  }
});

app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

// Cron jobs for automatic billing and notifications
const cronJobs = require('./cron/jobs')(db);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WISP CRM running on http://localhost:${PORT}`);
});
