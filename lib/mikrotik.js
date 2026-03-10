/**
 * MikroTik RouterOS REST API Helper
 * Works with RouterOS 7.x+ (REST API built-in)
 * Uses the www service (port 80) for REST calls
 */
const axios = require('axios');

class MikroTik {
  constructor(settings) {
    this.host = settings.mikrotik_host;
    this.port = settings.mikrotik_port || '80';
    this.user = settings.mikrotik_user;
    this.pass = settings.mikrotik_pass;
    this.baseURL = `http://${this.host}:${this.port}/rest`;
    this.auth = { username: this.user, password: this.pass };
  }

  isConfigured() {
    return !!(this.host && this.user);
  }

  async request(method, path, data = null) {
    const config = {
      method,
      url: `${this.baseURL}${path}`,
      auth: this.auth,
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    };
    if (data) config.data = data;
    const res = await axios(config);
    return res.data;
  }

  // Test connection
  async testConnection() {
    try {
      const identity = await this.request('GET', '/system/identity');
      const resource = await this.request('GET', '/system/resource');
      return {
        success: true,
        identity: identity.name || identity[0]?.name,
        version: resource.version || resource[0]?.version,
        uptime: resource.uptime || resource[0]?.uptime
      };
    } catch (err) {
      return {
        success: false,
        error: err.response?.data?.message || err.message
      };
    }
  }

  // ========== PPPoE Secret Management ==========

  async findPPPoESecret(pppoeUser) {
    try {
      const secrets = await this.request('GET', `/ppp/secret?name=${encodeURIComponent(pppoeUser)}`);
      return Array.isArray(secrets) ? secrets[0] : secrets;
    } catch (err) {
      return null;
    }
  }

  async disablePPPoESecret(pppoeUser) {
    const secret = await this.findPPPoESecret(pppoeUser);
    if (!secret) {
      throw new Error(`Usuario PPPoE "${pppoeUser}" no encontrado en MikroTik`);
    }
    await this.request('PATCH', `/ppp/secret/${secret['.id']}`, { disabled: 'true' });

    // Also remove active connection if exists
    try {
      const active = await this.request('GET', `/ppp/active?name=${encodeURIComponent(pppoeUser)}`);
      const conn = Array.isArray(active) ? active[0] : active;
      if (conn && conn['.id']) {
        await this.request('POST', '/ppp/active/remove', { '.id': conn['.id'] });
      }
    } catch (e) {
      // Active connection may not exist, that's fine
    }

    return { success: true, message: `PPPoE "${pppoeUser}" deshabilitado` };
  }

  async enablePPPoESecret(pppoeUser) {
    const secret = await this.findPPPoESecret(pppoeUser);
    if (!secret) {
      throw new Error(`Usuario PPPoE "${pppoeUser}" no encontrado en MikroTik`);
    }
    await this.request('PATCH', `/ppp/secret/${secret['.id']}`, { disabled: 'false' });
    return { success: true, message: `PPPoE "${pppoeUser}" habilitado` };
  }

  // ========== Address List Management (for static IP clients) ==========

  async addToBlockList(ipAddress, comment) {
    try {
      // Check if already in list
      const existing = await this.request('GET',
        `/ip/firewall/address-list?list=morosos&address=${encodeURIComponent(ipAddress)}`);
      const entry = Array.isArray(existing) ? existing[0] : existing;
      if (entry && entry['.id']) {
        return { success: true, message: `IP ${ipAddress} ya estaba en lista de morosos` };
      }
    } catch (e) {
      // List might be empty
    }

    await this.request('PUT', '/ip/firewall/address-list', {
      list: 'morosos',
      address: ipAddress,
      comment: comment || 'Corte por mora - CRM'
    });
    return { success: true, message: `IP ${ipAddress} agregada a lista de morosos` };
  }

  async removeFromBlockList(ipAddress) {
    try {
      const existing = await this.request('GET',
        `/ip/firewall/address-list?list=morosos&address=${encodeURIComponent(ipAddress)}`);
      const entry = Array.isArray(existing) ? existing[0] : existing;
      if (entry && entry['.id']) {
        await this.request('POST', '/ip/firewall/address-list/remove', { '.id': entry['.id'] });
        return { success: true, message: `IP ${ipAddress} removida de lista de morosos` };
      }
    } catch (e) {
      // Entry not found
    }
    return { success: true, message: `IP ${ipAddress} no estaba en lista de morosos` };
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

    // If client has both PPPoE and IP, also block IP as extra measure for PPPoE
    if (client.connection_type === 'pppoe' && client.ip_address) {
      try {
        const comment = `${client.first_name} ${client.last_name} - Corte PPPoE`;
        await this.addToBlockList(client.ip_address, comment);
      } catch (e) {
        // Optional, don't fail the whole operation
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

    // Remove from block list (for both PPPoE and static IP)
    if (client.ip_address) {
      const r = await this.removeFromBlockList(client.ip_address);
      results.push(r);
    }

    return results;
  }
}

module.exports = MikroTik;
