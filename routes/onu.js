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

  // HSGQ GPON OLT OIDs (enterprise 50224)
  const HSGQ_OIDS = {
    // ONU table: 1.3.6.1.4.1.50224.3.12.2.1.{column}.{index}
    onuId:        '1.3.6.1.4.1.50224.3.12.2.1.2',   // ONU ID: "ONT01/000"
    onuStatus:    '1.3.6.1.4.1.50224.3.12.2.1.4',   // Status: 1=online, 2=offline
    onuVendor:    '1.3.6.1.4.1.50224.3.12.2.1.8',   // Vendor: "HWTC", "ECOM"
    onuModel:     '1.3.6.1.4.1.50224.3.12.2.1.9',   // Model: "HG8546M"
    onuHwVer:     '1.3.6.1.4.1.50224.3.12.2.1.10',  // HW version
    onuSwVer:     '1.3.6.1.4.1.50224.3.12.2.1.13',  // SW version / firmware
    onuSerial:    '1.3.6.1.4.1.50224.3.12.2.1.15',  // Serial: "HWTC1f9ac49c"
    onuDesc:      '1.3.6.1.4.1.50224.3.12.2.1.16',  // Description (usually empty)
    onuLastSeen:  '1.3.6.1.4.1.50224.3.12.2.1.20',  // Last registration: "2026/04/20 02:59:10"
    onuUptime:    '1.3.6.1.4.1.50224.3.12.2.1.21',  // Uptime timeticks
    // PON port summary: 1.3.6.1.4.1.50224.3.2.3.1.{column}.{portIndex}
    ponOnuTotal:  '1.3.6.1.4.1.50224.3.2.3.1.3',    // Total ONUs per PON
    ponOnuOnline: '1.3.6.1.4.1.50224.3.2.3.1.4',    // Online ONUs per PON
    ponOnuOffline:'1.3.6.1.4.1.50224.3.2.3.1.5',    // Offline ONUs per PON
    // Optical power (may be in 3.12.3)
    onuRxPower:   '1.3.6.1.4.1.50224.3.12.3.1.4',   // RX power (to verify)
    onuTxPower:   '1.3.6.1.4.1.50224.3.12.3.1.5',   // TX power (to verify)
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

  // Helper: build a map from SNMP walk results keyed by the last OID index
  function buildMap(results, baseOid) {
    const map = {};
    const baseLen = baseOid.split('.').length;
    for (const r of results) {
      const parts = r.oid.split('.');
      // ONU table has single index after base, power table has 3-part index
      const idx = parts[baseLen]; // main ONU index
      if (idx) {
        let val = r.value;
        if (Buffer.isBuffer(val)) val = val.toString('utf8');
        map[idx] = String(val).replace(/\0/g, '').trim();
      }
    }
    return map;
  }

  // API: SNMP - Discover all ONUs from OLT
  router.get('/api/snmp/discover', async (req, res) => {
    const settings = getSettings();
    const oltHost = settings.olt_host;
    const community = settings.snmp_community || 'public';

    if (!oltHost) return res.json({ error: 'Configure la IP de la OLT en Configuracion' });

    try {
      // Walk all ONU attributes in parallel
      const [serials, statuses, onuIds, vendors, models, firmwares, lastSeens, rxPowers, txPowers] =
        await Promise.all([
          snmpWalk(oltHost, community, HSGQ_OIDS.onuSerial, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuStatus, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuId, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuVendor, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuModel, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuSwVer, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuLastSeen, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuRxPower, 30000).catch(() => []),
          snmpWalk(oltHost, community, HSGQ_OIDS.onuTxPower, 30000).catch(() => []),
        ]);

      if (serials.length === 0) {
        return res.json({ onus: [], total: 0, error: 'No se encontraron ONUs. Verifique la IP de la OLT y la comunidad SNMP.' });
      }

      // Build maps keyed by ONU index
      const statusMap   = buildMap(statuses, HSGQ_OIDS.onuStatus);
      const idMap       = buildMap(onuIds, HSGQ_OIDS.onuId);
      const vendorMap   = buildMap(vendors, HSGQ_OIDS.onuVendor);
      const modelMap    = buildMap(models, HSGQ_OIDS.onuModel);
      const fwMap       = buildMap(firmwares, HSGQ_OIDS.onuSwVer);
      const lastSeenMap = buildMap(lastSeens, HSGQ_OIDS.onuLastSeen);

      // Power table has 3-part index: {onuIndex}.{sub1}.{sub2} - extract main index
      const rxMap = {};
      const txMap = {};
      const rxBaseLen = HSGQ_OIDS.onuRxPower.split('.').length;
      const txBaseLen = HSGQ_OIDS.onuTxPower.split('.').length;
      for (const r of rxPowers) {
        const parts = r.oid.split('.');
        const idx = parts[rxBaseLen];
        if (idx && !rxMap[idx]) rxMap[idx] = r.value; // take first sub-index
      }
      for (const r of txPowers) {
        const parts = r.oid.split('.');
        const idx = parts[txBaseLen];
        if (idx && !txMap[idx]) txMap[idx] = r.value;
      }

      // Build ONU list from serials
      const onus = [];
      const serialBaseLen = HSGQ_OIDS.onuSerial.split('.').length;

      for (const s of serials) {
        const parts = s.oid.split('.');
        const idx = parts[serialBaseLen];
        if (!idx) continue;

        const serial = String(s.value).replace(/\0/g, '').trim();
        if (!serial) continue;

        const onuIdStr = idMap[idx] || '';
        // Parse PON port from ONU ID like "ONT01/000" → PON 1
        const ponMatch = onuIdStr.match(/ONT(\d+)/);
        const ponPort = ponMatch ? parseInt(ponMatch[1]) : '';

        // Status: 1=online, 2=offline
        const statusVal = parseInt(statusMap[idx]) || 0;
        const status = statusVal === 1 ? 'online' : statusVal === 2 ? 'offline' : 'unknown';

        // Optical power: values are in hundredths of dBm (e.g., -2481 = -24.81 dBm)
        const rxRaw = parseInt(rxMap[idx]);
        const txRaw = parseInt(txMap[idx]);
        const rxDbm = !isNaN(rxRaw) ? (rxRaw / 100) : null;
        const txDbm = !isNaN(txRaw) ? (txRaw / 100) : null;

        onus.push({
          index: idx,
          ponPort: ponPort,
          onuId: onuIdStr,
          serial: serial,
          vendor: vendorMap[idx] || '',
          model: modelMap[idx] || '',
          firmware: fwMap[idx] || '',
          lastSeen: lastSeenMap[idx] || '',
          status: status,
          rxPower: rxDbm !== null ? rxDbm.toFixed(2) + ' dBm' : '',
          txPower: txDbm !== null ? txDbm.toFixed(2) + ' dBm' : '',
          rxDbm: rxDbm,
          txDbm: txDbm,
        });
      }

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

      // Sort: online first, then by PON port and ONU ID
      onus.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
        if (a.ponPort !== b.ponPort) return (a.ponPort || 0) - (b.ponPort || 0);
        return (a.onuId || '').localeCompare(b.onuId || '');
      });

      res.json({ onus, total: onus.length, online: onus.filter(o => o.status === 'online').length, error: null });
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

      // Try walking HSGQ enterprise tree (50224) to check if ONU OIDs work
      let hsgqWorks = false;
      let onuCount = 0;
      try {
        const test = await snmpWalk(oltHost, community, HSGQ_OIDS.ponOnuTotal, 8000);
        hsgqWorks = test.length > 0;
        // Sum total ONUs across all PON ports
        for (const t of test) {
          const v = parseInt(t.value);
          if (!isNaN(v)) onuCount += v;
        }
      } catch(e) {}

      res.json({
        success: true,
        description: desc,
        name: name,
        hsgqOids: hsgqWorks,
        onuCount: onuCount,
        message: hsgqWorks
          ? `OLT conectada - HSGQ detectada - ${onuCount} ONUs registradas`
          : 'OLT conectada - OIDs de ONU no detectados, verifique la configuracion SNMP'
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

  // SNMP SET helper
  function snmpSet(host, community, oid, type, value) {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(host, community, { timeout: 10000, retries: 1, version: snmp.Version2c });
      const varbinds = [{ oid: oid, type: type, value: value }];
      session.set(varbinds, (error, varbinds) => {
        session.close();
        if (error) return reject(error);
        resolve(varbinds);
      });
    });
  }

  // API: SNMP - Reboot ONU via OLT
  // HSGQ OLT uses admin action OID to reset/reboot an ONU
  // Column 3 in ONU table (3.12.2.1.3.{index}) is typically admin status: set to 2 to reset
  router.post('/api/snmp/reboot/:index', async (req, res) => {
    const settings = getSettings();
    const oltHost = settings.olt_host;
    const writeCommunity = settings.snmp_write_community || 'private';

    if (!oltHost) return res.json({ success: false, error: 'OLT no configurada' });

    try {
      const idx = req.params.index;
      // Admin reset OID: set column 3 to 2 (reset/reboot)
      const resetOid = '1.3.6.1.4.1.50224.3.12.2.1.3.' + idx;
      await snmpSet(oltHost, writeCommunity, resetOid, snmp.ObjectType.Integer, 2);
      res.json({ success: true, message: 'Comando de reinicio enviado a la ONU' });
    } catch (e) {
      res.json({ success: false, error: 'Error SNMP SET: ' + e.message });
    }
  });

  // API: Assign ONU serial to a client service
  router.post('/api/snmp/assign', (req, res) => {
    const { serial, serviceId } = req.body;
    if (!serial || !serviceId) return res.json({ success: false, error: 'Serial y servicio requeridos' });

    try {
      db.prepare('UPDATE client_services SET onu_serial = ? WHERE id = ?').run(serial, serviceId);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // API: Unassign ONU serial from a client service
  router.post('/api/snmp/unassign', (req, res) => {
    const { serial } = req.body;
    if (!serial) return res.json({ success: false, error: 'Serial requerido' });

    try {
      db.prepare("UPDATE client_services SET onu_serial = '' WHERE onu_serial = ? COLLATE NOCASE").run(serial);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // API: Get all clients/services for assignment dropdown
  router.get('/api/snmp/clients', (req, res) => {
    try {
      const services = db.prepare(`
        SELECT cs.id as service_id, cs.plan_name, cs.pppoe_user, cs.onu_serial,
               c.id as client_id, c.first_name, c.last_name
        FROM client_services cs
        JOIN clients c ON c.id = cs.client_id
        ORDER BY c.last_name, c.first_name
      `).all();
      res.json({ services });
    } catch (e) {
      res.json({ services: [], error: e.message });
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
