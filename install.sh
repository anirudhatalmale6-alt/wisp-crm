#!/bin/bash
# =========================================
# WISP CRM - Script de Instalación
# Para Ubuntu Server 20.04/22.04/24.04
# =========================================

set -e

echo "========================================="
echo "  WISP CRM - Instalación Automática"
echo "========================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Por favor ejecute como root (sudo ./install.sh)"
  exit 1
fi

# Update system
echo "[1/6] Actualizando sistema..."
apt update -y && apt upgrade -y

# Install Node.js 18
echo "[2/6] Instalando Node.js..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt install -y nodejs
fi
echo "Node.js $(node -v) instalado"

# Install build tools (for better-sqlite3)
echo "[3/6] Instalando herramientas de compilación..."
apt install -y build-essential python3

# Create application directory
APP_DIR="/opt/wisp-crm"
echo "[4/6] Configurando aplicación en $APP_DIR..."

if [ -d "$APP_DIR" ]; then
  echo "Directorio $APP_DIR ya existe. Haciendo respaldo..."
  cp -r "$APP_DIR/data" "/tmp/wisp-crm-backup-$(date +%Y%m%d)" 2>/dev/null || true
fi

# Copy files
mkdir -p "$APP_DIR"
cp -r . "$APP_DIR/"
cd "$APP_DIR"

# Install dependencies
echo "[5/6] Instalando dependencias..."
npm install --production

# Create data directory
mkdir -p data

# Create .env if not exists
if [ ! -f .env ]; then
  SECRET=$(openssl rand -hex 32)
  cat > .env << EOF
PORT=3000
SESSION_SECRET=$SECRET
ADMIN_USER=admin
ADMIN_PASS=admin123
WHATSAPP_API_URL=https://graph.facebook.com/v17.0
WHATSAPP_PHONE_ID=
WHATSAPP_TOKEN=
EOF
  echo "Archivo .env creado con valores por defecto"
fi

# Create systemd service
echo "[6/6] Configurando servicio del sistema..."
cat > /etc/systemd/system/wisp-crm.service << EOF
[Unit]
Description=WISP CRM
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start service
systemctl daemon-reload
systemctl enable wisp-crm
systemctl start wisp-crm

# Get server IP
SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "========================================="
echo "  ¡WISP CRM instalado exitosamente!"
echo "========================================="
echo ""
echo "  URL:      http://$SERVER_IP:3000"
echo "  Usuario:  admin"
echo "  Contraseña: admin123"
echo ""
echo "  Comandos útiles:"
echo "    sudo systemctl status wisp-crm   (ver estado)"
echo "    sudo systemctl restart wisp-crm  (reiniciar)"
echo "    sudo systemctl stop wisp-crm     (detener)"
echo "    sudo journalctl -u wisp-crm -f   (ver logs)"
echo ""
echo "  IMPORTANTE: Cambie la contraseña desde"
echo "  Configuración > Cambiar Contraseña"
echo "========================================="
