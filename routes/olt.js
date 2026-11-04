/**
 * ZTE C300/C320 OLT management (SmartOLT-style), mounted at /olt, admin only.
 *
 * Until the ZTE OLT is configured in Settings, every screen runs on the demo
 * stand-in (lib/zte-olt-demo.js), which can show everything and send nothing.
 *
 * Every write goes through two calls: the first returns the exact CLI lines,
 * the second (confirm: true) sends them. Nothing reaches the OLT that the
 * operator has not seen first.
 */
const express = require('express');
const ZteOlt = require('../lib/zte-olt');
const ZteOltDemo = require('../lib/zte-olt-demo');

const CACHE_MS = 60 * 1000;

module.exports = function(db) {
  const router = express.Router();

  const getSettings = () => {
    const s = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => s[r.key] = r.value);
    return s;
  };

  const isDemo = (req, s) => {
    const live = ZteOlt.fromSettings(s);
    return !live.isConfigured() || req.query.demo === '1' || (req.body && req.body.demo === true);
  };

  const getOlt = (req, s) => isDemo(req, s) ? new ZteOltDemo() : ZteOlt.fromSettings(s);

  // The OLT allows very few concurrent sessions: run one job at a time
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const cache = { demo: null, live: null };
  const invalidate = () => { cache.live = null; };

  const log = (req, entry) => {
    try {
      db.prepare(`INSERT INTO olt_log (user_id, user_name, action, onu_index, serial, commands, output, ok)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        req.session.user.id, req.session.user.name || req.session.user.username,
        entry.action, entry.onuIndex || null, entry.serial || null,
        (entry.commands || []).join('\n'), (entry.output || '').slice(0, 20000), entry.ok ? 1 : 0
      );
    } catch (e) {
      console.error('[OLT] could not write olt_log:', e.message);
    }
  };

  const scriptOutput = (r) => (r.results || []).map(x => `> ${x.command}\n${x.output}`).join('\n');

  // CRM services that already know their ONU, keyed by serial and by OLT index
  const crmIndex = () => {
    const rows = db.prepare(`
      SELECT cs.id as service_id, cs.label, cs.onu_serial, cs.olt_onu_index, cs.pppoe_user,
             c.id as client_id, c.first_name, c.last_name, c.archived_at
      FROM client_services cs JOIN clients c ON c.id = cs.client_id
      WHERE (cs.onu_serial IS NOT NULL AND cs.onu_serial != '')
         OR (cs.olt_onu_index IS NOT NULL AND cs.olt_onu_index != '')`).all();
    const bySerial = {};
    const byIndex = {};
    for (const r of rows) {
      const link = {
        serviceId: r.service_id, clientId: r.client_id,
        name: `${r.first_name} ${r.last_name}`.trim(),
        label: r.label || '', pppoeUser: r.pppoe_user || '', archived: !!r.archived_at
      };
      if (r.onu_serial) bySerial[r.onu_serial.trim().toUpperCase()] = link;
      if (r.olt_onu_index) byIndex[r.olt_onu_index] = link;
    }
    return { bySerial, byIndex };
  };

  async function loadData(req, s, refresh) {
    const demo = isDemo(req, s);
    const key = demo ? 'demo' : 'live';
    if (!refresh && cache[key] && Date.now() - cache[key].at < CACHE_MS) return cache[key];
    const olt = getOlt(req, s);
    const raw = await exclusive(() => olt.listAll());
    cache[key] = { at: Date.now(), demo, raw };
    return cache[key];
  }

  function enrich(raw, demo) {
    const crm = demo ? { bySerial: {}, byIndex: {} } : crmIndex();
    let demoN = 0;
    const registered = raw.registered.map(o => {
      let client = (o.serial && crm.bySerial[o.serial]) || crm.byIndex[o.onuIndex] || null;
      if (demo) client = { name: `Cliente de ejemplo ${++demoN}`, demo: true };
      return { ...o, signal: ZteOlt.gradeSignal(o.rx), client };
    });
    // Free ids are handed out in order, so two new ONUs on one port never collide
    const taken = {};
    const unconfigured = raw.unconfigured.map((u, i) => {
      taken[u.ponPort] = taken[u.ponPort] || [];
      const freeId = ZteOlt.nextFreeOnuId(u.ponPort, raw.registered, taken[u.ponPort]);
      if (freeId) taken[u.ponPort].push(freeId);
      let client = crm.bySerial[u.serial] || null;
      // In the demo, two of the three new ONUs pretend their serial is already
      // on a client, so the "authorise all" button has something to show
      if (demo) client = i < 2 ? { name: `Cliente de ejemplo nuevo ${i + 1}`, demo: true, serviceId: null } : null;
      return { ...u, freeId, client };
    });
    const stats = {
      total: registered.length,
      online: registered.filter(o => o.online).length,
      offline: registered.filter(o => !o.online).length,
      lowSignal: registered.filter(o => o.signal.level === 'warn' || o.signal.level === 'critical').length,
      unconfigured: unconfigured.length,
      unlinked: registered.filter(o => !o.client).length
    };
    return { registered, unconfigured, ports: raw.ports, stats };
  }

  // In the demo, empty defaults get example values so every screen can be
  // shown; with the real OLT an empty VLAN or profile is an error the
  // operator has to fix, never a guess.
  function authorizeDefaults(s, body, demo) {
    return {
      onuType: body.onuType || s.zte_default_onu_type || (demo ? 'ZTE-F660' : ''),
      vlan: body.vlan || s.zte_default_vlan || (demo ? '100' : ''),
      tcontProfile: body.tcontProfile || s.zte_tcont_profile || (demo ? '1G' : ''),
      mode: body.mode === 'register' ? 'register' : 'bridge'
    };
  }

  // ===== Page =====
  router.get('/', (req, res) => {
    const s = getSettings();
    const live = ZteOlt.fromSettings(s);
    res.render('olt/index', {
      configured: live.isConfigured(),
      demo: isDemo(req, s),
      host: s.zte_host || '',
      transport: live.transport,
      defaults: authorizeDefaults(s, {}, isDemo(req, s))
    });
  });

  // ===== Reads =====
  router.get('/api/data', async (req, res) => {
    const s = getSettings();
    try {
      const data = await loadData(req, s, req.query.refresh === '1');
      res.json({ ok: true, demo: data.demo, fetchedAt: data.at, ...enrich(data.raw, data.demo) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  router.get('/api/detail', async (req, res) => {
    const s = getSettings();
    try {
      const index = ZteOlt.assertIndex(req.query.index);
      const olt = getOlt(req, s);
      const d = await exclusive(() => olt.getOnuDetail(index));
      res.json({ ok: true, index, ...d, signal: ZteOlt.gradeSignal(d.power.onuRx) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  router.get('/api/test', async (req, res) => {
    const s = getSettings();
    const olt = getOlt(req, s);
    res.json(await exclusive(() => olt.testConnection()));
  });

  // Services of one client, for the "assign to client" picker
  router.get('/api/client-services', (req, res) => {
    const client = db.prepare('SELECT id, first_name, last_name FROM clients WHERE id = ?').get(req.query.client_id);
    if (!client) return res.json({ ok: false, error: 'Cliente no encontrado' });
    const services = db.prepare(`SELECT cs.id, cs.label, cs.pppoe_user, cs.onu_serial, cs.olt_onu_index, p.name as plan_name
      FROM client_services cs LEFT JOIN plans p ON p.id = cs.plan_id WHERE cs.client_id = ? ORDER BY cs.id`).all(client.id);
    res.json({ ok: true, client: { id: client.id, name: `${client.first_name} ${client.last_name}`.trim() }, services });
  });

  router.get('/api/log', (req, res) => {
    const rows = db.prepare('SELECT id, user_name, action, onu_index, serial, ok, created_at FROM olt_log ORDER BY id DESC LIMIT 100').all();
    res.json({ ok: true, rows });
  });

  // ===== Authorise one ONU =====
  router.post('/api/authorize', async (req, res) => {
    const s = getSettings();
    const b = req.body || {};
    const demo = isDemo(req, s);
    try {
      const d = authorizeDefaults(s, b, demo);
      const serial = ZteOlt.assertSerial(b.serial);

      let service = null;
      if (b.serviceId) {
        service = db.prepare(`SELECT cs.*, c.first_name, c.last_name FROM client_services cs
          JOIN clients c ON c.id = cs.client_id WHERE cs.id = ?`).get(b.serviceId);
        if (!service) throw new Error('El servicio elegido no existe');
      }
      const name = b.name || (service ? ZteOlt.safeOnuName(`${service.first_name}_${service.last_name}`) : '');

      // Re-check against the OLT's current state, not against what the page saw
      const data = await loadData(req, s, false);
      if (data.raw.registered.some(o => (o.serial || '') === serial)) {
        throw new Error(`El serial ${serial} ya esta registrado en la OLT`);
      }
      const onuId = parseInt(b.onuId, 10);
      if (data.raw.registered.some(o => o.ponPort === b.port && o.onuId === onuId)) {
        throw new Error(`El ID ${onuId} ya esta ocupado en ${b.port}`);
      }

      const built = ZteOlt.buildAuthorize({
        port: b.port, onuId, serial, name, description: b.description || null,
        onuType: d.onuType, vlan: d.vlan, tcontProfile: d.tcontProfile, mode: d.mode
      });
      const commands = b.save === false ? built.commands : built.commands.concat(ZteOlt.SAVE_CONFIG);

      if (!b.confirm) return res.json({ ok: true, preview: true, demo, index: built.index, commands });
      if (demo) return res.json({ ok: false, demo: true, error: 'Modo demostracion: no hay OLT conectada, no se envio nada.' });

      const olt = ZteOlt.fromSettings(s);
      const r = await exclusive(() => olt.runScript(commands, { commandTimeout: 30000 }));
      log(req, { action: 'authorize', onuIndex: built.index, serial, commands, output: scriptOutput(r), ok: r.ok });
      invalidate();

      if (!r.ok) {
        return res.json({ ok: false, error: `La OLT rechazo "${commands[r.failedAt]}": ${r.error}`, output: scriptOutput(r) });
      }
      if (service) {
        db.prepare('UPDATE client_services SET onu_serial = ?, olt_onu_index = ? WHERE id = ?').run(serial, built.index, service.id);
      }
      res.json({ ok: true, index: built.index, output: scriptOutput(r) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ===== Authorise every new ONU whose serial is already on a CRM client =====
  // This is what makes the night of the OLT swap short.
  router.post('/api/bulk-authorize', async (req, res) => {
    const s = getSettings();
    const b = req.body || {};
    const demo = isDemo(req, s);
    try {
      const d = authorizeDefaults(s, b, demo);
      const data = await loadData(req, s, !!b.confirm);
      const view = enrich(data.raw, data.demo);
      const plan = [];
      const skipped = [];
      // Ids are handed out only to the ONUs actually being authorised, so a
      // skipped ONU never leaves a gap on its port
      const taken = {};
      for (const u of view.unconfigured) {
        if (!u.client) { skipped.push({ serial: u.serial, reason: 'No esta en ningun cliente del CRM' }); continue; }
        if (u.client.archived) { skipped.push({ serial: u.serial, reason: `${u.client.name} esta archivado` }); continue; }
        taken[u.ponPort] = taken[u.ponPort] || [];
        const onuId = ZteOlt.nextFreeOnuId(u.ponPort, data.raw.registered, taken[u.ponPort]);
        if (!onuId) { skipped.push({ serial: u.serial, reason: `No quedan IDs libres en ${u.ponPort}` }); continue; }
        try {
          const built = ZteOlt.buildAuthorize({
            port: u.ponPort, onuId, serial: u.serial,
            name: ZteOlt.safeOnuName(u.client.name), description: null,
            onuType: d.onuType, vlan: d.vlan, tcontProfile: d.tcontProfile, mode: d.mode
          });
          taken[u.ponPort].push(onuId);
          plan.push({ serial: u.serial, serviceId: u.client.serviceId, client: u.client.name, index: built.index, commands: built.commands });
        } catch (e) {
          skipped.push({ serial: u.serial, reason: e.message });
        }
      }

      if (!b.confirm) return res.json({ ok: true, preview: true, demo, plan, skipped });
      if (demo) return res.json({ ok: false, demo: true, error: 'Modo demostracion: no hay OLT conectada, no se envio nada.' });
      if (!plan.length) return res.json({ ok: false, error: 'No hay ONUs nuevas que coincidan con clientes del CRM' });

      const olt = ZteOlt.fromSettings(s);
      const results = [];
      for (const item of plan) {
        const r = await exclusive(() => olt.runScript(item.commands, { commandTimeout: 30000 }));
        log(req, { action: 'authorize-bulk', onuIndex: item.index, serial: item.serial, commands: item.commands, output: scriptOutput(r), ok: r.ok });
        if (r.ok) {
          db.prepare('UPDATE client_services SET onu_serial = ?, olt_onu_index = ? WHERE id = ?').run(item.serial, item.index, item.serviceId);
        }
        results.push({ serial: item.serial, client: item.client, index: item.index, ok: r.ok,
          error: r.ok ? null : `${item.commands[r.failedAt]}: ${r.error}` });
      }
      // One save at the end instead of one per ONU
      const saved = await exclusive(() => olt.runScript(ZteOlt.SAVE_CONFIG, { commandTimeout: 60000 }));
      log(req, { action: 'write', commands: ZteOlt.SAVE_CONFIG, output: scriptOutput(saved), ok: saved.ok });
      invalidate();
      res.json({ ok: true, results, skipped, saved: saved.ok });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ===== Reboot / enable / disable / delete =====
  router.post('/api/action', async (req, res) => {
    const s = getSettings();
    const b = req.body || {};
    const demo = isDemo(req, s);
    try {
      const index = ZteOlt.assertIndex(b.index);
      let commands;
      if (b.action === 'reboot') commands = ZteOlt.buildReboot(index);
      else if (b.action === 'disable') commands = ZteOlt.buildSetAdminState(index, false);
      else if (b.action === 'enable') commands = ZteOlt.buildSetAdminState(index, true);
      else if (b.action === 'delete') commands = ZteOlt.buildDelete(index);
      else throw new Error('Accion desconocida');
      // A reboot changes nothing in the config; everything else must survive an OLT restart
      if (b.action !== 'reboot') commands = commands.concat(ZteOlt.SAVE_CONFIG);

      if (!b.confirm) return res.json({ ok: true, preview: true, demo, commands });
      if (demo) return res.json({ ok: false, demo: true, error: 'Modo demostracion: no hay OLT conectada, no se envio nada.' });

      const olt = ZteOlt.fromSettings(s);
      const r = await exclusive(() => olt.runScript(commands, { commandTimeout: 30000 }));
      log(req, { action: b.action, onuIndex: index, commands, output: scriptOutput(r), ok: r.ok });
      invalidate();
      if (!r.ok) return res.json({ ok: false, error: `La OLT rechazo "${commands[r.failedAt]}": ${r.error}`, output: scriptOutput(r) });
      if (b.action === 'delete') {
        // The ONU no longer exists on the OLT; keep the serial so it can be re-authorised
        db.prepare('UPDATE client_services SET olt_onu_index = NULL WHERE olt_onu_index = ?').run(index);
      }
      res.json({ ok: true, output: scriptOutput(r) });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ===== Raw console (live only, logged) =====
  router.post('/api/console', async (req, res) => {
    const s = getSettings();
    const command = String((req.body && req.body.command) || '').trim();
    if (isDemo(req, s)) return res.json({ ok: false, error: 'La consola solo funciona con la OLT real configurada.' });
    if (!command) return res.json({ ok: false, error: 'Escriba un comando' });
    if (/[\r\n]/.test(command) || command.length > 300) return res.json({ ok: false, error: 'Un solo comando por vez' });
    try {
      const olt = ZteOlt.fromSettings(s);
      const output = await exclusive(() => olt.exec(command, { commandTimeout: 30000 }));
      log(req, { action: 'console', commands: [command], output, ok: !ZteOlt.CLI_ERROR.test(output) });
      if (!/^(show|ping|display)\b/i.test(command)) invalidate();
      res.json({ ok: true, output });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  return router;
};
