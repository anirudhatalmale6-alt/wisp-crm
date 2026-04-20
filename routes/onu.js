const express = require('express');
const { Client } = require('ssh2');
const axios = require('axios');

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

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
