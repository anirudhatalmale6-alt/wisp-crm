const express = require('express');
const { Client } = require('ssh2');
const axios = require('axios');
const snmp = require('net-snmp');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  // ========== SNMP OLT Integration ==========

  // VSOL/HSGQ GPON OLT OIDs (enterprise 37950)
  const VSOL_OIDS = {
    onuSerial:    '1.3.6.1.4.1.37950.1.1.6.1.1.2.1.5',   // ONU serial number table
    onuRxPower:   '1.3.6.1.4.1.37950.1.1.6.1.1.3.1.7',   // ONU RX optical power
    onuStatus:    '1.3.6.1.4.1.37950.1.1.5.10.1.2.3.1.2', // PON port status
    onuCountOnline: '1.3.6.1.4.1.37950.1.1.6.1.1.18.1.3', // ONUs online per PON
    onuCountTotal:  '1.3.6.1.4.1.37950.1.1.6.1.1.18.1.2', // ONUs provisioned per PON
    ponSfpTx:     '1.3.6.1.4.1.37950.1.1.5.10.13.1.1.5',  // OLT SFP TX power per PON
    ponSfpTemp:   '1.3.6.1.4.1.37950.1.1.5.10.13.1.1.2',  // OLT SFP temp per PON
  };

  // SNMP walk helper
  function snmpWalk(host, community, oid, timeout) {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(host, community, { timeout: timeout || 10000, retries: 1, version: snmp.Version2c });
      const results = [];

      session.subtree(oid, 20, (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          let value = vb.value;
          if (Buffer.isBuffer(value)) value = value.toString('utf8');
          results.push({ oid: vb.oid, type: vb.type, value: value });
        }
      }, (error) => {
        session.close();
        if (error && results.length === 0) reject(error);
        else resolve(results);
      });
    });
  }

  // SNMP get helper (single OID)
  function snmpGet(host, community, oids) {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(host, community, { timeout: 10000, retries: 1, version: snmp.Version2c });
      session.get(oids, (error, varbinds) => {
        session.close();
        if (error) return reject(error);
        resolve(varbinds.map(vb => {
          let value = vb.value;
          if (Buffer.isBuffer(value)) value = value.toString('utf8');
          return { oid: vb.oid, type: vb.type, value: value };
        }));
      });
    });
  }

  // Parse dBm from VSOL power string like "0.03 mW (-19.25 dBm)"
  function parseVsolPower(val) {
    if (!val) return null;
    const str = String(val);
    const match = str.match(/\((-?[\d.]+)\s*dBm\)/);
    if (match) return parseFloat(match[1]);
    // Try plain number
    const num = parseFloat(str);
    if (!isNaN(num)) return num;
    return null;
  }

  // API: SNMP - Discover all ONUs from OLT
  router.get('/api/snmp/discover', async (req, res) => {
    const settings = getSettings();
    const oltHost = settings.olt_host;
    const community = settings.snmp_community || 'public';

    if (!oltHost) return res.json({ error: 'Configure la IP de la OLT en Configuracion' });

    try {
      // Walk ONU serial numbers
      let serials = [];
      try {
        serials = await snmpWalk(oltHost, community, VSOL_OIDS.onuSerial, 15000);
      } catch(e) {
        // Try alternative enterprise OIDs if VSOL doesn't work
        // C-Data (34592)
        try {
          serials = await snmpWalk(oltHost, community, '1.3.6.1.4.1.34592.1.3.4.1.1.3', 15000);
        } catch(e2) {
          // NSCRTV (17409)
          try {
            serials = await snmpWalk(oltHost, community, '1.3.6.1.4.1.17409.2.8.4.1.1.3', 15000);
          } catch(e3) {}
        }
      }

      // Walk RX power
      let powers = [];
      try {
        powers = await snmpWalk(oltHost, community, VSOL_OIDS.onuRxPower, 15000);
      } catch(e) {
        try {
          powers = await snmpWalk(oltHost, community, '1.3.6.1.4.1.34592.1.3.4.1.1.36', 15000);
        } catch(e2) {}
      }

      // Build ONU list
      const onus = [];
      const powerMap = {};
      powers.forEach(p => {
        // Extract index from OID suffix
        const parts = p.oid.split('.');
        const idx = parts.slice(-2).join('.');
        powerMap[idx] = p.value;
      });

      serials.forEach((s, i) => {
        const parts = s.oid.split('.');
        const idx = parts.slice(-2).join('.');
        const serial = String(s.value).replace(/\0/g, '').trim();

        // Parse PON port and ONU ID from index
        const ponPort = parts.length >= 2 ? parts[parts.length - 2] : '';
        const onuId = parts.length >= 1 ? parts[parts.length - 1] : '';

        const rxRaw = powerMap[idx] || '';
        const rxDbm = parseVsolPower(rxRaw);

        onus.push({
          index: idx,
          ponPort: ponPort,
          onuId: onuId,
          serial: serial,
          rxPower: rxDbm !== null ? rxDbm.toFixed(2) + ' dBm' : (rxRaw ? String(rxRaw) : ''),
          rxDbm: rxDbm,
          status: rxDbm !== null ? 'online' : 'unknown'
        });
      });

      // Cross-reference with CRM services to show which ONUs are assigned
      const assignedSerials = {};
      db.prepare(`SELECT cs.onu_serial, cs.id as service_id, c.id as client_id, c.first_name, c.last_name
        FROM client_services cs JOIN clients c ON c.id = cs.client_id
        WHERE cs.onu_serial IS NOT NULL AND cs.onu_serial != ''`).all().forEach(row => {
        assignedSerials[row.onu_serial.toUpperCase()] = {
          serviceId: row.service_id,
          clientId: row.client_id,
          clientName: row.first_name + ' ' + row.last_name
        };
      });

      onus.forEach(onu => {
        const assigned = assignedSerials[onu.serial.toUpperCase()];
        if (assigned) {
          onu.assigned = true;
          onu.clientId = assigned.clientId;
          onu.clientName = assigned.clientName;
        } else {
          onu.assigned = false;
        }
      });

      res.json({ onus, total: onus.length, error: null });
    } catch (e) {
      res.json({ onus: [], total: 0, error: 'Error SNMP: ' + e.message });
    }
  });

  // API: SNMP - Test connection to OLT
  router.get('/api/snmp/test', async (req, res) => {
    const settings = getSettings();
    const oltHost = settings.olt_host;
    const community = settings.snmp_community || 'public';

    if (!oltHost) return res.json({ success: false, error: 'Configure la IP de la OLT' });

    try {
      // Try to get sysDescr (standard OID)
      const result = await snmpGet(oltHost, community, ['1.3.6.1.2.1.1.1.0']);
      const desc = result[0] ? String(result[0].value) : 'Desconocido';

      // Try to get sysName
      let name = '';
      try {
        const nameResult = await snmpGet(oltHost, community, ['1.3.6.1.2.1.1.5.0']);
        name = nameResult[0] ? String(nameResult[0].value) : '';
      } catch(e) {}

      // Try walking VSOL enterprise tree to check if OIDs work
      let vsolWorks = false;
      try {
        const test = await snmpWalk(oltHost, community, '1.3.6.1.4.1.37950.1.1.6.1.1.18', 8000);
        vsolWorks = test.length > 0;
      } catch(e) {}

      res.json({
        success: true,
        description: desc,
        name: name,
        vsolOids: vsolWorks,
        message: vsolWorks ? 'OLT conectada - OIDs VSOL/HSGQ detectados' : 'OLT conectada - probando OIDs alternativos...'
      });
    } catch (e) {
      res.json({ success: false, error: 'No se pudo conectar: ' + e.message });
    }
  });

  // API: SNMP - Walk arbitrary OID (for debugging/discovery)
  router.get('/api/snmp/walk', async (req, res) => {
    const settings = getSettings();
    const oltHost = settings.olt_host;
    const community = settings.snmp_community || 'public';
    const oid = req.query.oid;

    if (!oltHost) return res.json({ error: 'Configure la IP de la OLT' });
    if (!oid) return res.json({ error: 'OID requerido' });

    try {
      const results = await snmpWalk(oltHost, community, oid, 15000);
      res.json({ results, count: results.length });
    } catch (e) {
      res.json({ error: e.message, results: [], count: 0 });
    }
  });

  // ========== GenieACS TR-069 Integration ==========

  const getNbiUrl = () => {
    const settings = getSettings();
    return settings.genieacs_url || 'http://localhost:7557';
  };

  // API: Get all devices from GenieACS
  router.get('/api/devices', async (req, res) => {
    try {
      const resp = await axios.get(`${getNbiUrl()}/devices`, { timeout: 5000 });
      res.json(resp.data);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // API: Get device by serial number
  router.get('/api/device/:serial', async (req, res) => {
    try {
      const filter = encodeURIComponent(JSON.stringify({ "_id": { "$regex": req.params.serial } }));
      const resp = await axios.get(`${getNbiUrl()}/devices?query=${filter}`, { timeout: 5000 });
      if (resp.data && resp.data.length > 0) {
        const device = resp.data[0];
        const info = {
          id: device._id,
          online: device._lastInform ? (Date.now() - new Date(device._lastInform).getTime()) < 300000 : false,
          lastInform: device._lastInform,
          manufacturer: device._deviceId ? device._deviceId._Manufacturer : '',
          productClass: device._deviceId ? device._deviceId._ProductClass : '',
          serialNumber: device._deviceId ? device._deviceId._SerialNumber : '',
          ssid: '',
          wifiPassword: '',
          ip: '',
          mac: '',
          softwareVersion: '',
          hardwareVersion: '',
          hosts: []
        };
        // Extract parameters
        const p = device;
        const igd = 'InternetGatewayDevice';
        if (p[igd]) {
          if (p[igd].LANDevice && p[igd].LANDevice['1'] && p[igd].LANDevice['1'].WLANConfiguration && p[igd].LANDevice['1'].WLANConfiguration['1']) {
            const wlan = p[igd].LANDevice['1'].WLANConfiguration['1'];
            info.ssid = wlan.SSID ? wlan.SSID._value : '';
            info.wifiPassword = wlan.KeyPassphrase ? wlan.KeyPassphrase._value : (wlan.PreSharedKey ? wlan.PreSharedKey['1'] ? wlan.PreSharedKey['1'].PreSharedKey ? wlan.PreSharedKey['1'].PreSharedKey._value : '' : '' : '');
          }
          if (p[igd].WANDevice && p[igd].WANDevice['1'] && p[igd].WANDevice['1'].WANConnectionDevice && p[igd].WANDevice['1'].WANConnectionDevice['1'] && p[igd].WANDevice['1'].WANConnectionDevice['1'].WANIPConnection && p[igd].WANDevice['1'].WANConnectionDevice['1'].WANIPConnection['1']) {
            const wan = p[igd].WANDevice['1'].WANConnectionDevice['1'].WANIPConnection['1'];
            info.ip = wan.ExternalIPAddress ? wan.ExternalIPAddress._value : '';
            info.mac = wan.MACAddress ? wan.MACAddress._value : '';
          }
          if (p[igd].DeviceInfo) {
            info.softwareVersion = p[igd].DeviceInfo.SoftwareVersion ? p[igd].DeviceInfo.SoftwareVersion._value : '';
            info.hardwareVersion = p[igd].DeviceInfo.HardwareVersion ? p[igd].DeviceInfo.HardwareVersion._value : '';
          }
          // Extract optical power (RX/TX) - try multiple common TR-069 paths
          info.rxPower = '';
          info.txPower = '';
          // Path 1: X_GponInterafceConfig (some vendors)
          if (p[igd].WANDevice && p[igd].WANDevice['1']) {
            const wd = p[igd].WANDevice['1'];
            if (wd.X_GponInterafceConfig) {
              info.rxPower = wd.X_GponInterafceConfig.RXPower ? wd.X_GponInterafceConfig.RXPower._value : '';
              info.txPower = wd.X_GponInterafceConfig.TXPower ? wd.X_GponInterafceConfig.TXPower._value : '';
            }
            // Path 2: X_GponInterfaceConfig (alternate spelling)
            if (!info.rxPower && wd.X_GponInterfaceConfig) {
              info.rxPower = wd.X_GponInterfaceConfig.RXPower ? wd.X_GponInterfaceConfig.RXPower._value : '';
              info.txPower = wd.X_GponInterfaceConfig.TXPower ? wd.X_GponInterfaceConfig.TXPower._value : '';
            }
          }
          // Path 3: Search all keys for optical/gpon/rx/tx power patterns
          if (!info.rxPower) {
            const searchPower = (obj, prefix) => {
              if (!obj || typeof obj !== 'object') return;
              for (const key of Object.keys(obj)) {
                const fullKey = prefix ? prefix + '.' + key : key;
                if (key.match(/RXPower|RxPower|rxpower|OpticalSignalLevel|RxOpticalPower/i) && obj[key] && obj[key]._value !== undefined) {
                  info.rxPower = obj[key]._value;
                }
                if (key.match(/TXPower|TxPower|txpower|TransmitOpticalLevel|TxOpticalPower/i) && obj[key] && obj[key]._value !== undefined) {
                  info.txPower = obj[key]._value;
                }
                if (typeof obj[key] === 'object' && obj[key] !== null && !obj[key]._value && fullKey.split('.').length < 8) {
                  searchPower(obj[key], fullKey);
                }
              }
            };
            searchPower(p[igd], igd);
          }
          // Path 4: Check Device.Optical if using Device:2 data model
          if (!info.rxPower && p['Device']) {
            const searchPower2 = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              for (const key of Object.keys(obj)) {
                if (key.match(/RXPower|RxPower|OpticalSignalLevel|RxOpticalPower|SignalLevel/i) && obj[key] && obj[key]._value !== undefined) {
                  info.rxPower = info.rxPower || obj[key]._value;
                }
                if (key.match(/TXPower|TxPower|TransmitOpticalLevel|TxOpticalPower/i) && obj[key] && obj[key]._value !== undefined) {
                  info.txPower = info.txPower || obj[key]._value;
                }
                if (typeof obj[key] === 'object' && obj[key] !== null && !obj[key]._value) {
                  searchPower2(obj[key]);
                }
              }
            };
            searchPower2(p['Device']);
          }
          // Convert to dBm if numeric
          if (info.rxPower && !isNaN(info.rxPower)) {
            const rx = parseFloat(info.rxPower);
            // Some ONUs report in mW (0.0001-5), convert to dBm
            if (rx > 0 && rx < 10) {
              info.rxPower = (10 * Math.log10(rx)).toFixed(2) + ' dBm';
            } else {
              info.rxPower = rx.toFixed(2) + ' dBm';
            }
          }
          if (info.txPower && !isNaN(info.txPower)) {
            const tx = parseFloat(info.txPower);
            if (tx > 0 && tx < 10) {
              info.txPower = (10 * Math.log10(tx)).toFixed(2) + ' dBm';
            } else {
              info.txPower = tx.toFixed(2) + ' dBm';
            }
          }
          // Get LAN hosts
          if (p[igd].LANDevice && p[igd].LANDevice['1'] && p[igd].LANDevice['1'].Hosts && p[igd].LANDevice['1'].Hosts.Host) {
            const hosts = p[igd].LANDevice['1'].Hosts.Host;
            Object.keys(hosts).forEach(k => {
              if (hosts[k] && hosts[k].HostName) {
                info.hosts.push({
                  name: hosts[k].HostName._value || '',
                  ip: hosts[k].IPAddress ? hosts[k].IPAddress._value : '',
                  mac: hosts[k].MACAddress ? hosts[k].MACAddress._value : ''
                });
              }
            });
          }
        }
        res.json(info);
      } else {
        res.json({ error: 'ONU no encontrada en GenieACS' });
      }
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // API: Change WiFi SSID and/or password
  router.post('/api/device/:serial/wifi', async (req, res) => {
    try {
      const { ssid, password } = req.body;
      const filter = encodeURIComponent(JSON.stringify({ "_id": { "$regex": req.params.serial } }));
      const resp = await axios.get(`${getNbiUrl()}/devices?query=${filter}`, { timeout: 5000 });
      if (!resp.data || resp.data.length === 0) return res.json({ error: 'ONU no encontrada' });

      const deviceId = encodeURIComponent(resp.data[0]._id);
      const paramValues = [];
      if (ssid) paramValues.push(["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", ssid, "xsd:string"]);
      if (password) paramValues.push(["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", password, "xsd:string"]);

      if (paramValues.length === 0) return res.json({ error: 'Debe especificar SSID o contrasena' });

      await axios.post(`${getNbiUrl()}/devices/${deviceId}/tasks?connection_request`, {
        name: "setParameterValues",
        parameterValues: paramValues
      }, { timeout: 10000 });

      res.json({ success: true, message: 'WiFi actualizado. El cambio puede tardar unos segundos.' });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // API: Refresh all parameter values from ONU (forces GenieACS to re-read)
  router.post('/api/device/:serial/refresh', async (req, res) => {
    try {
      const filter = encodeURIComponent(JSON.stringify({ "_id": { "$regex": req.params.serial } }));
      const resp = await axios.get(`${getNbiUrl()}/devices?query=${filter}`, { timeout: 5000 });
      if (!resp.data || resp.data.length === 0) return res.json({ error: 'ONU no encontrada' });

      const deviceId = encodeURIComponent(resp.data[0]._id);
      await axios.post(`${getNbiUrl()}/devices/${deviceId}/tasks?connection_request`, {
        name: "getParameterValues",
        parameterNames: [
          "InternetGatewayDevice.WANDevice.",
          "InternetGatewayDevice.LANDevice.",
          "InternetGatewayDevice.DeviceInfo."
        ]
      }, { timeout: 10000 });

      res.json({ success: true, message: 'Solicitud de actualizacion enviada. Espere unos segundos y recargue.' });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // API: Reboot ONU
  router.post('/api/device/:serial/reboot', async (req, res) => {
    try {
      const filter = encodeURIComponent(JSON.stringify({ "_id": { "$regex": req.params.serial } }));
      const resp = await axios.get(`${getNbiUrl()}/devices?query=${filter}`, { timeout: 5000 });
      if (!resp.data || resp.data.length === 0) return res.json({ error: 'ONU no encontrada' });

      const deviceId = encodeURIComponent(resp.data[0]._id);
      await axios.post(`${getNbiUrl()}/devices/${deviceId}/tasks?connection_request`, {
        name: "reboot"
      }, { timeout: 10000 });

      res.json({ success: true, message: 'Comando de reinicio enviado' });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // Execute command on OLT via SSH
  function execOltCommand(settings, command, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let output = '';
      let timer;

      conn.on('ready', () => {
        conn.shell((err, stream) => {
          if (err) { conn.end(); return reject(err); }

          timer = setTimeout(() => {
            conn.end();
            resolve(output);
          }, timeout);

          stream.on('data', (data) => {
            output += data.toString();
          });

          stream.on('close', () => {
            clearTimeout(timer);
            conn.end();
            resolve(output);
          });

          // Send command directly (no enable - user mode)
          // Also try enable with password in case it works
          setTimeout(() => {
            stream.write('enable\n');
            setTimeout(() => {
              // Try password for enable mode
              stream.write(settings.olt_pass + '\n');
              setTimeout(() => {
                stream.write('terminal length 0\n');
                setTimeout(() => {
                  stream.write(command + '\n');
                  setTimeout(() => {
                    stream.write('exit\n');
                    setTimeout(() => stream.end(), 2000);
                  }, 5000);
                }, 500);
              }, 1000);
            }, 1000);
          }, 500);
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      conn.connect({
        host: settings.olt_host,
        port: parseInt(settings.olt_port) || 22,
        username: settings.olt_user,
        password: settings.olt_pass,
        readyTimeout: 10000,
        algorithms: {
          kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'diffie-hellman-group-exchange-sha256', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes256-cbc', '3des-cbc'],
          hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'],
          serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519']
        }
      });
    });
  }

  // Try multiple commands to discover ONU info
  async function discoverOnus(settings) {
    const commands = [
      'show gpon onu state',
      'show gpon onu-info all',
      'show onu status gpon-olt 0/0',
      'show gpon remote-onu all',
      'show gpon onu info all',
      'show onu running status'
    ];

    let allOutput = '';
    for (const cmd of commands) {
      try {
        const output = await execOltCommand(settings, cmd, 10000);
        allOutput += `\n--- ${cmd} ---\n${output}`;
      } catch (e) {
        allOutput += `\n--- ${cmd} (error: ${e.message}) ---\n`;
      }
    }
    return allOutput;
  }

  // Parse ONU data from OLT output
  function parseOnuData(rawOutput) {
    const onus = [];
    const lines = rawOutput.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Pattern: PON port/ONU ID with status (online/offline)
      // Common formats: "0/0:1  online  HWTC-12345678"  or  "gpon-olt 0/0  ONU 1  online"
      let match;

      // Format: "X/Y:Z  status  SN" (VSOL style)
      match = line.match(/(\d+\/\d+):(\d+)\s+(online|offline|inactive|active|deactivated)\s+([\w-]+)?/i);
      if (match) {
        onus.push({
          port: match[1],
          onuId: match[2],
          status: match[3].toLowerCase(),
          sn: match[4] || '',
          description: '',
          rxPower: '',
          raw: line
        });
        continue;
      }

      // Format: "ONU X  SN:XXXX  Status:online"
      match = line.match(/ONU\s+(\d+).*?(?:SN|sn)[:\s]+([\w-]+).*?(?:Status|status|State|state)[:\s]+(online|offline|inactive|active)/i);
      if (match) {
        onus.push({
          port: '',
          onuId: match[1],
          status: match[3].toLowerCase(),
          sn: match[2] || '',
          description: '',
          rxPower: '',
          raw: line
        });
        continue;
      }

      // Format: table row with multiple columns containing online/offline
      match = line.match(/(\d+)\s+(\d+)\s+([\w:-]+)\s+(online|offline|active|inactive|deactivated)/i);
      if (match) {
        onus.push({
          port: match[1],
          onuId: match[2],
          status: match[4].toLowerCase(),
          sn: match[3] || '',
          description: '',
          rxPower: '',
          raw: line
        });
        continue;
      }
    }

    return onus;
  }

  // ONU management page
  router.get('/', async (req, res) => {
    const settings = getSettings();

    if (!settings.olt_host || !settings.olt_user) {
      return res.render('onu/index', {
        settings,
        onus: [],
        rawOutput: '',
        error: 'Configure la OLT en Configuracion primero (IP, usuario y contrasena)',
        connected: false
      });
    }

    try {
      // Try to get ONU list
      const rawOutput = await discoverOnus(settings);
      const onus = parseOnuData(rawOutput);

      res.render('onu/index', {
        settings,
        onus,
        rawOutput,
        error: null,
        connected: true
      });
    } catch (err) {
      res.render('onu/index', {
        settings,
        onus: [],
        rawOutput: '',
        error: `Error conectando a la OLT: ${err.message}`,
        connected: false
      });
    }
  });

  // Execute raw commands on OLT (no auto-enable, sends commands as-is)
  function execOltRaw(settings, commands, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let output = '';
      let timer;

      conn.on('ready', () => {
        conn.shell((err, stream) => {
          if (err) { conn.end(); return reject(err); }

          timer = setTimeout(() => {
            conn.end();
            resolve(output);
          }, timeout);

          stream.on('data', (data) => {
            output += data.toString();
          });

          stream.on('close', () => {
            clearTimeout(timer);
            conn.end();
            resolve(output);
          });

          // Send each command with a small delay
          const cmds = commands.split('\n').filter(c => c.trim());
          let i = 0;
          function sendNext() {
            if (i < cmds.length) {
              stream.write(cmds[i] + '\n');
              i++;
              setTimeout(sendNext, 1000);
            } else {
              setTimeout(() => {
                stream.write('exit\n');
                setTimeout(() => stream.end(), 2000);
              }, 5000);
            }
          }
          setTimeout(sendNext, 500);
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      conn.connect({
        host: settings.olt_host,
        port: parseInt(settings.olt_port) || 22,
        username: settings.olt_user,
        password: settings.olt_pass,
        readyTimeout: 10000,
        algorithms: {
          kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'diffie-hellman-group-exchange-sha256', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes256-cbc', '3des-cbc'],
          hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'],
          serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519']
        }
      });
    });
  }

  // API: Execute custom command on OLT
  router.post('/api/command', async (req, res) => {
    const settings = getSettings();
    const { command } = req.body;

    if (!settings.olt_host || !settings.olt_user) {
      return res.json({ error: 'OLT no configurada' });
    }
    if (!command) {
      return res.json({ error: 'Comando requerido' });
    }

    try {
      const output = await execOltRaw(settings, command, 15000);
      res.json({ output, error: null });
    } catch (err) {
      res.json({ output: '', error: err.message });
    }
  });

  // API: Test OLT connection
  router.post('/api/test', async (req, res) => {
    const settings = getSettings();

    if (!settings.olt_host || !settings.olt_user) {
      return res.json({ success: false, error: 'OLT no configurada' });
    }

    try {
      const output = await execOltCommand(settings, 'show version', 10000);
      res.json({ success: true, output });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  return router;
};
