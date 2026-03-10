/**
 * MikroTik RouterOS SSH Helper
 * Connects via SSH (port 22) and executes CLI commands
 * More reliable than REST API as SSH is typically open in firewall
 */
const { Client } = require('ssh2');

class MikroTik {
  constructor(settings) {
    this.host = settings.mikrotik_host;
    this.port = parseInt(settings.mikrotik_port) || 22;
    this.user = settings.mikrotik_user;
    this.pass = settings.mikrotik_pass;
  }

  isConfigured() {
    return !!(this.host && this.user);
  }

  // Execute a command on MikroTik via SSH
  exec(command) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let output = '';
      let errorOutput = '';

      const timer = setTimeout(() => {
        conn.end();
        reject(new Error('Timeout: no se pudo conectar en 10 segundos'));
      }, 10000);

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }
          stream.on('data', (data) => { output += data.toString(); });
          stream.stderr.on('data', (data) => { errorOutput += data.toString(); });
          stream.on('close', () => {
            clearTimeout(timer);
            conn.end();
            resolve(output.trim());
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`SSH: ${err.message}`));
      });

      conn.connect({
        host: this.host,
        port: this.port,
        username: this.user,
        password: this.pass,
        readyTimeout: 8000,
        algorithms: {
          kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
                'diffie-hellman-group-exchange-sha256', 'ecdh-sha2-nistp256',
                'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
        }
      });
    });
  }

  // Test connection
  async testConnection() {
    try {
      const identity = await this.exec('/system identity print');
      const resource = await this.exec('/system resource print');

      // Parse identity name
      const nameMatch = identity.match(/name:\s*(.+)/i);
      const identityName = nameMatch ? nameMatch[1].trim() : identity.trim();

      // Parse version and uptime
      const versionMatch = resource.match(/version:\s*(.+)/im);
      const uptimeMatch = resource.match(/uptime:\s*(.+)/im);

      return {
        success: true,
        identity: identityName,
        version: versionMatch ? versionMatch[1].trim() : '',
        uptime: uptimeMatch ? uptimeMatch[1].trim() : ''
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  // ========== PPPoE Secret Management ==========

  async disablePPPoESecret(pppoeUser) {
    // Disable the PPPoE secret
    const result = await this.exec(`/ppp secret set [find name="${pppoeUser}"] disabled=yes`);

    // Remove active connection to force disconnect
    try {
      await this.exec(`/ppp active remove [find name="${pppoeUser}"]`);
    } catch (e) {
      // Active connection may not exist
    }

    return { success: true, message: `PPPoE "${pppoeUser}" deshabilitado` };
  }

  async enablePPPoESecret(pppoeUser) {
    await this.exec(`/ppp secret set [find name="${pppoeUser}"] disabled=no`);
    return { success: true, message: `PPPoE "${pppoeUser}" habilitado` };
  }

  // ========== Address List Management (for static IP clients) ==========

  async addToBlockList(ipAddress, comment) {
    // Check if already exists
    const existing = await this.exec(`/ip firewall address-list print where list=MOROSO address="${ipAddress}"`);
    if (existing && !existing.includes('no such item') && existing.trim().length > 10) {
      return { success: true, message: `IP ${ipAddress} ya estaba en lista de MOROSO` };
    }

    const safeComment = (comment || 'Corte por mora - CRM').replace(/"/g, '\\"');
    await this.exec(`/ip firewall address-list add list=MOROSO address=${ipAddress} comment="${safeComment}"`);
    return { success: true, message: `IP ${ipAddress} agregada a lista de MOROSO` };
  }

  async removeFromBlockList(ipAddress) {
    try {
      await this.exec(`/ip firewall address-list remove [find list=MOROSO address="${ipAddress}"]`);
      return { success: true, message: `IP ${ipAddress} removida de lista de MOROSO` };
    } catch (e) {
      return { success: true, message: `IP ${ipAddress} no estaba en lista de MOROSO` };
    }
  }

  // ========== Unified Cut/Reconnect ==========

  async cutService(client) {
    const results = [];

    // PPPoE clients: disable the secret
    if (client.connection_type === 'pppoe' && client.pppoe_user) {
      const r = await this.disablePPPoESecret(client.pppoe_user);
      results.push(r);
    }

    // Static IP clients: add to block list
    if (client.ip_address && client.connection_type !== 'pppoe') {
      const comment = `${client.first_name} ${client.last_name} - Corte`;
      const r = await this.addToBlockList(client.ip_address, comment);
      results.push(r);
    }

    // PPPoE with IP: also block IP as extra measure
    if (client.connection_type === 'pppoe' && client.ip_address) {
      try {
        const comment = `${client.first_name} ${client.last_name} - Corte PPPoE`;
        await this.addToBlockList(client.ip_address, comment);
      } catch (e) {
        // Optional
      }
    }

    return results;
  }

  async reconnectService(client) {
    const results = [];

    // PPPoE clients: enable the secret
    if (client.connection_type === 'pppoe' && client.pppoe_user) {
      const r = await this.enablePPPoESecret(client.pppoe_user);
      results.push(r);
    }

    // Remove from block list
    if (client.ip_address) {
      const r = await this.removeFromBlockList(client.ip_address);
      results.push(r);
    }

    return results;
  }
}

module.exports = MikroTik;
