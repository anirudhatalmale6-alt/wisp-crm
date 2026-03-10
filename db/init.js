const bcrypt = require('bcryptjs');

module.exports = function(db) {
  // Users table
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Plans table
  db.exec(`CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    speed_down TEXT NOT NULL,
    speed_up TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Clients table
  db.exec(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    phone2 TEXT,
    email TEXT,
    address TEXT,
    city TEXT,
    neighborhood TEXT,
    plan_id INTEGER,
    connection_type TEXT DEFAULT 'pppoe',
    pppoe_user TEXT,
    pppoe_password TEXT,
    ip_address TEXT,
    mac_address TEXT,
    router_name TEXT,
    installation_date DATE,
    billing_day INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    latitude REAL,
    longitude REAL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  )`);

  // Add lat/lng columns if they don't exist (migration for existing DBs)
  try { db.exec('ALTER TABLE clients ADD COLUMN latitude REAL'); } catch(e) {}
  try { db.exec('ALTER TABLE clients ADD COLUMN longitude REAL'); } catch(e) {}
  try { db.exec('ALTER TABLE clients ADD COLUMN google_maps_link TEXT'); } catch(e) {}

  // MikroTik action queue (for reverse polling)
  db.exec(`CREATE TABLE IF NOT EXISTS mikrotik_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    pppoe_user TEXT,
    ip_address TEXT,
    connection_type TEXT,
    client_name TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);

  // Invoices table
  db.exec(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    invoice_number TEXT UNIQUE NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    amount REAL NOT NULL,
    tax REAL DEFAULT 0,
    total REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    due_date DATE NOT NULL,
    paid_date DATE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);

  // Payments table
  db.exec(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    invoice_id INTEGER,
    amount REAL NOT NULL,
    payment_method TEXT DEFAULT 'cash',
    reference TEXT,
    notes TEXT,
    receipt_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id)
  )`);

  // WhatsApp message log
  db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    template TEXT,
    status TEXT DEFAULT 'sent',
    direction TEXT DEFAULT 'outgoing',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);

  // Message templates
  db.exec(`CREATE TABLE IF NOT EXISTS message_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Settings table
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT
  )`);

  // Service cuts log
  db.exec(`CREATE TABLE IF NOT EXISTS service_cuts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    automatic INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )`);

  // Create default admin user
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASS || 'admin123', 10);
    db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run(
      process.env.ADMIN_USER || 'admin', hash, 'Administrador', 'admin'
    );
  }

  // Default settings
  const defaults = [
    ['company_name', 'RYV Comunicaciones', 'Nombre de la empresa'],
    ['company_phone', '', 'Teléfono de la empresa'],
    ['currency', 'RD$', 'Símbolo de moneda'],
    ['tax_rate', '0', 'Porcentaje de impuesto (ITBIS)'],
    ['grace_days', '5', 'Días de gracia antes del corte'],
    ['auto_cut_enabled', '1', 'Corte automático habilitado'],
    ['payment_reminder_days', '3', 'Días antes del vencimiento para recordatorio'],
    ['whatsapp_enabled', '0', 'WhatsApp habilitado'],
    ['mikrotik_host', '', 'IP del MikroTik'],
    ['mikrotik_port', '8728', 'Puerto API del MikroTik'],
    ['mikrotik_user', '', 'Usuario API del MikroTik'],
    ['mikrotik_pass', '', 'Contraseña API del MikroTik'],
  ];

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)');
  for (const [key, value, desc] of defaults) {
    insertSetting.run(key, value, desc);
  }

  // Default message templates
  const templates = [
    ['payment_reminder', 'recordatorio', 'Hola {nombre}, le recordamos que su factura #{factura} por {monto} vence el {fecha_vencimiento}. Por favor realice su pago a tiempo para evitar la suspensión del servicio. Gracias.'],
    ['payment_received', 'comprobante', 'Hola {nombre}, hemos recibido su pago de {monto} para la factura #{factura}. Su servicio está al día. ¡Gracias por su pago!'],
    ['service_suspended', 'suspension', 'Hola {nombre}, su servicio de internet ha sido suspendido por falta de pago. Su saldo pendiente es {monto}. Realice su pago para reactivar el servicio inmediatamente.'],
    ['service_reconnected', 'reconexion', 'Hola {nombre}, su servicio de internet ha sido reactivado exitosamente. Gracias por ponerse al día con su pago.'],
    ['welcome', 'bienvenida', 'Bienvenido/a {nombre} a {empresa}. Su servicio de internet ha sido activado. Plan: {plan}, Velocidad: {velocidad}. Para soporte contacte al {telefono_empresa}.'],
  ];

  const insertTemplate = db.prepare('INSERT OR IGNORE INTO message_templates (name, category, content) VALUES (?, ?, ?)');
  for (const [name, cat, content] of templates) {
    insertTemplate.run(name, cat, content);
  }

  // Insert sample plans
  const planCount = db.prepare('SELECT COUNT(*) as count FROM plans').get();
  if (planCount.count === 0) {
    const insertPlan = db.prepare('INSERT INTO plans (name, speed_down, speed_up, price, description) VALUES (?, ?, ?, ?, ?)');
    insertPlan.run('Básico', '5 Mbps', '2 Mbps', 500, 'Plan básico residencial');
    insertPlan.run('Estándar', '10 Mbps', '5 Mbps', 800, 'Plan estándar residencial');
    insertPlan.run('Premium', '20 Mbps', '10 Mbps', 1200, 'Plan premium residencial');
    insertPlan.run('Empresarial', '50 Mbps', '25 Mbps', 2500, 'Plan empresarial');
  }
};
