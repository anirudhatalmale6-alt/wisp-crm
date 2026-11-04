/**
 * ZTE C300 / C320 GPON OLT driver
 *
 * Talks to the OLT the same way SmartOLT does: an interactive CLI session
 * over SSH or Telnet. C300 and C320 share the same ZXAN command set.
 *
 * Two things make the OLT CLI different from the MikroTik one in lib/mikrotik.js:
 *   - ZTE does not support `conn.exec()`. Everything goes through a shell where
 *     you write a command and read until the prompt comes back.
 *   - Output is paged (`--More--`). Paging is disabled per session, but the
 *     reader still answers the pager in case the OLT ignores it.
 *
 * Prompts look like: ZXAN>  ZXAN#  ZXAN(config)#  ZXAN(config-if)#
 *                    ZXAN(gpon-onu-mng 1/1/1:1)#   <- note the space and slashes
 *
 * NOTE ON FIRMWARE: the read commands are stable across C300/C320 firmwares.
 * The provisioning builders at the bottom are the part that varies, so every
 * one of them is shown to the operator before it is sent, and the first real
 * authorisation must be watched on the live OLT.
 */
const net = require('net');
const { Client } = require('ssh2');

// Hostname, optional "(mode ...)" with anything but parens inside, then > or #
const PROMPT = /[A-Za-z0-9_.\-]+(\([^()\r\n]*\))?\s*[>#]\s*$/;
const LOGIN = /(user\s*name|login)\s*:\s*$/i;
const PASSWORD = /password\s*:\s*$/i;
const MORE = /--\s*More\s*--|---- More ----/i;
// ZTE reports failures as lines starting with %: "%Error 20223: ...", "%Code 32310-GPONSRV : ..."
const CLI_ERROR = /^\s*%\s*\S/m;

const MAX_ONU_ID = 128;

class ZteOlt {
  /**
   * cfg: { host, port, transport: 'ssh'|'telnet', user, pass, enablePass }
   */
  constructor(cfg) {
    cfg = cfg || {};
    this.host = cfg.host;
    this.user = cfg.user;
    this.pass = cfg.pass;
    this.transport = (cfg.transport || 'telnet').toLowerCase() === 'ssh' ? 'ssh' : 'telnet';
    this.port = parseInt(cfg.port) || (this.transport === 'telnet' ? 23 : 22);
    // Some OLTs ask for a separate enable password; falls back to the login one
    this.enablePass = cfg.enablePass || cfg.pass;
    this.demo = false;
  }

  /** The ZTE OLT has its own zte_* settings so it can coexist with the current OLT */
  static fromSettings(s) {
    return new ZteOlt({
      host: s.zte_host,
      port: s.zte_port,
      transport: s.zte_transport,
      user: s.zte_user,
      pass: s.zte_pass,
      enablePass: s.zte_enable_pass
    });
  }

  isConfigured() {
    return !!(this.host && this.user);
  }

  /**
   * Open one session, hand it to fn(session), always close it.
   * One session per job: the C320 allows very few concurrent logins, so
   * opening one per command locks the operator out fast.
   */
  async withSession(fn, opts = {}) {
    const session = await this._open(opts.connectTimeout || 15000);
    try {
      return await fn(session);
    } finally {
      session.close();
    }
  }

  /** Run every command in order in one session. Returns [{ command, output }] */
  async run(commands, opts = {}) {
    const list = Array.isArray(commands) ? commands : [commands];
    return this.withSession(async (session) => {
      const results = [];
      for (const cmd of list) {
        results.push({ command: cmd, output: await session.send(cmd, opts.commandTimeout || 20000) });
      }
      return results;
    }, opts);
  }

  /** Convenience: run one command, get its output text */
  async exec(command, opts = {}) {
    const [r] = await this.run([command], opts);
    return r.output;
  }

  /**
   * Run a provisioning script. Stops at the first command the OLT rejects,
   * because everything after it (gemport, service-port...) depends on it.
   * Returns { ok, results, failedAt, error }
   */
  async runScript(commands, opts = {}) {
    return this.withSession(async (session) => {
      const results = [];
      for (let i = 0; i < commands.length; i++) {
        const output = await session.send(commands[i], opts.commandTimeout || 20000);
        results.push({ command: commands[i], output });
        if (CLI_ERROR.test(output)) {
          const line = output.split('\n').find(l => /^\s*%/.test(l)) || output;
          return { ok: false, results, failedAt: i, error: line.trim() };
        }
      }
      return { ok: true, results, failedAt: null, error: null };
    }, opts);
  }

  // ========== Session handling ==========

  _open(timeout) {
    return this.transport === 'ssh' ? this._openSsh(timeout) : this._openTelnet(timeout);
  }

  /**
   * Wraps a duplex stream into { send(cmd), readUntil(), write(), close() }.
   * readUntil resolves when the buffer ends in a prompt (or a login/password
   * question), feeding the pager a space whenever `--More--` shows up.
   */
  _wrap(stream, close) {
    let buffer = '';
    let waiter = null;
    let afterPager = false;

    const check = () => {
      if (!waiter) return;
      const tail = buffer.slice(-120);
      if (MORE.test(tail)) {
        // Answer the pager and drop its marker from the captured text
        buffer = buffer.replace(/[ \t]*(--\s*More\s*--|---- More ----)[ \t]*/i, '');
        afterPager = true;
        stream.write(' ');
        return;
      }
      const lastLine = buffer.split(/\r?\n/).pop();
      let matched = null;
      if (PROMPT.test(lastLine)) matched = 'prompt';
      else if (PASSWORD.test(lastLine)) matched = 'password';
      else if (LOGIN.test(lastLine)) matched = 'login';
      if (matched) {
        const done = waiter;
        waiter = null;
        clearTimeout(done.timer);
        const text = buffer;
        buffer = '';
        done.resolve({ text, matched });
      }
    };

    stream.on('data', (d) => {
      let text = d.toString('utf8');
      if (afterPager) {
        // The OLT wipes the marker with a line break, backspaces or spaces
        // before carrying on; none of that is output
        text = text.replace(/^[\r\n \b]+/, '');
        if (!text) return;
        afterPager = false;
      }
      buffer += text;
      check();
    });

    const readUntil = (ms) => new Promise((resolve) => {
      // Resolve with whatever arrived on timeout rather than throwing: a slow
      // `show gpon onu state` on a full OLT is normal, and half an answer is
      // more useful than an exception.
      const timer = setTimeout(() => {
        waiter = null;
        const text = buffer;
        buffer = '';
        resolve({ text, matched: 'timeout' });
      }, ms);
      waiter = { resolve, timer };
      check();
    });

    return {
      readUntil,
      write(text) { stream.write(text); },
      async send(command, ms) {
        buffer = '';
        stream.write(command + '\r\n');
        const r = await readUntil(ms || 20000);
        return cleanOutput(r.text, command);
      },
      async sendRaw(command, ms) {
        buffer = '';
        stream.write(command + '\r\n');
        return readUntil(ms || 20000);
      },
      close
    };
  }

  async _prepare(session) {
    // Privileged mode. An admin login usually lands on "#" already; only answer
    // a password question if the OLT actually asks one.
    const en = await session.sendRaw('enable', 6000);
    if (en.matched === 'password') {
      const r = await session.sendRaw(this.enablePass || '', 6000);
      if (r.matched !== 'prompt' || !/#\s*$/.test(r.text.split(/\r?\n/).pop())) {
        throw new Error('La OLT rechazo la clave de enable');
      }
    }
    await session.send('terminal length 0', 6000);
    return session;
  }

  _openSsh(timeout) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`No se pudo conectar a la OLT ${this.host}:${this.port} por SSH`));
      }, timeout);

      conn.on('ready', () => {
        conn.shell({ term: 'vt100' }, async (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); return reject(err); }
          clearTimeout(timer);
          const session = this._wrap(stream, () => { try { stream.end(); } catch (e) {} conn.end(); });
          try {
            // Swallow the banner before issuing anything
            await session.readUntil(6000);
            resolve(await this._prepare(session));
          } catch (e) {
            session.close();
            reject(e);
          }
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`SSH OLT: ${err.message}`));
      });

      conn.connect({
        host: this.host,
        port: this.port,
        username: this.user,
        password: this.pass,
        readyTimeout: timeout,
        // Modern algorithms first, then the old ones ZTE firmware still uses
        // (without group1/group14-sha1 the handshake with an old C300 fails).
        // The server takes the first one on this list it also supports.
        algorithms: {
          kex: ['curve25519-sha256', 'ecdh-sha2-nistp256', 'diffie-hellman-group14-sha256',
                'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha1',
                'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes256-cbc', '3des-cbc',
                   'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com'],
          hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'],
          serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ssh-ed25519', 'rsa-sha2-256']
        }
      });
    });
  }

  _openTelnet(timeout) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`No se pudo conectar a la OLT ${this.host}:${this.port} por Telnet`));
      }, timeout);

      // Telnet option negotiation: refuse everything so the OLT falls back to
      // plain line mode, and strip the IAC bytes so parsers never see them.
      const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
      const { PassThrough } = require('stream');
      const clean = new PassThrough();
      socket.on('data', (chunk) => {
        const out = [];
        const reply = [];
        for (let i = 0; i < chunk.length; i++) {
          const b = chunk[i];
          if (b !== IAC) { out.push(b); continue; }
          const verb = chunk[i + 1];
          if (verb === DO || verb === DONT) { reply.push(IAC, WONT, chunk[i + 2]); i += 2; }
          else if (verb === WILL || verb === WONT) { reply.push(IAC, DONT, chunk[i + 2]); i += 2; }
          else if (verb === SB) { while (i < chunk.length && !(chunk[i] === IAC && chunk[i + 1] === SE)) i++; i++; }
          else if (verb === IAC) { out.push(IAC); i += 1; }
          else { i += 1; }
        }
        if (reply.length) socket.write(Buffer.from(reply));
        if (out.length) clean.write(Buffer.from(out));
      });
      // Writes go straight to the socket; reads come from the cleaned stream
      const duplex = { on: (ev, fn) => clean.on(ev, fn), write: (t) => socket.write(t) };

      socket.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error(`Telnet OLT: ${err.message}`));
      });

      socket.on('connect', async () => {
        const session = this._wrap(duplex, () => { try { socket.end(); socket.destroy(); } catch (e) {} });
        try {
          // Telnet login is a plain prompt exchange, not an auth handshake
          let r = await session.readUntil(8000);
          if (r.matched === 'login') {
            r = await session.sendRaw(this.user, 6000);
          }
          if (r.matched === 'password') {
            r = await session.sendRaw(this.pass || '', 8000);
          }
          if (r.matched !== 'prompt') {
            throw new Error(LOGIN.test(r.text) || PASSWORD.test(r.text)
              ? 'Usuario o clave de la OLT incorrectos'
              : 'La OLT no respondio con un prompt despues del login');
          }
          await this._prepare(session);
          clearTimeout(timer);
          if (settled) return session.close();
          settled = true;
          resolve(session);
        } catch (e) {
          clearTimeout(timer);
          session.close();
          if (settled) return;
          settled = true;
          reject(e);
        }
      });
    });
  }

  // ========== Reads ==========

  async testConnection() {
    try {
      const results = await this.run(['show version'], { commandTimeout: 15000 });
      const version = results[0].output;
      return {
        success: true,
        model: (version.match(/ZXA10\s+(\S+)/i) || [])[1] || 'ZTE',
        version: (version.match(/Version\s*:?\s*(V[\w.]+)/i) || [])[1] || '',
        raw: version
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Everything the ONU screen needs, in ONE session:
   *   show gpon onu state            -> every provisioned ONU + phase
   *   show gpon onu baseinfo <port>  -> serial + type, per PON port
   *   show pon power onu-rx <port>   -> customer-side signal, per PON port
   *   show gpon onu uncfg            -> ONUs on the fibre not yet authorised
   */
  async listAll() {
    return this.withSession(async (session) => {
      const state = parseOnuState(await session.send('show gpon onu state', 60000));
      const ports = [...new Set(state.map(o => o.ponPort).filter(Boolean))].sort(comparePorts);

      const base = {};
      const rx = {};
      for (const port of ports) {
        Object.assign(base, indexBy(parseOnuBaseinfo(await session.send(`show gpon onu baseinfo ${port}`, 30000))));
        // Best effort: older firmware lacks this command, the screen just shows "-"
        Object.assign(rx, parseRxPowerList(await session.send(`show pon power onu-rx ${port}`, 30000)));
      }
      const uncfg = parseUncfgOnus(await session.send('show gpon onu uncfg', 30000));

      const registered = state.map(o => {
        const b = base[o.onuIndex] || {};
        return {
          ...o,
          serial: b.serial || null,
          type: b.type || null,
          rx: rx[o.onuIndex] !== undefined ? rx[o.onuIndex] : null
        };
      });
      return { registered, unconfigured: uncfg, ports };
    });
  }

  async getOnuDetail(onuIndex) {
    const idx = assertIndex(onuIndex);
    return this.withSession(async (session) => {
      const detail = parseOnuDetail(await session.send(`show gpon onu detail-info ${idx}`, 20000));
      const power = parsePower(await session.send(`show pon power attenuation ${idx}`, 20000));
      return { detail, power };
    });
  }
}

// ========== Output parsing ==========

/** Strip the echoed command, the trailing prompt and any control noise */
function cleanOutput(text, command) {
  const t = (text || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // ANSI escapes
    .replace(/[\b]/g, '')
    .replace(/\r/g, '');
  const lines = t.split('\n');
  if (command && lines.length && lines[0].trim().endsWith(command.trim())) lines.shift();
  while (lines.length && (PROMPT.test(lines[lines.length - 1]) || lines[lines.length - 1].trim() === '')) lines.pop();
  return lines.join('\n').trim();
}

/** Normalise gpon_onu-1/1/1:1 and gpon-onu_1/1/1:1 to one form */
function normaliseIndex(raw) {
  const m = String(raw || '').match(/(\d+)\/(\d+)\/(\d+):(\d+)/);
  return m ? `gpon-onu_${m[1]}/${m[2]}/${m[3]}:${m[4]}` : raw;
}

function splitPonPort(onuIndex) {
  const m = String(onuIndex || '').match(/(\d+)\/(\d+)\/(\d+):(\d+)/);
  if (!m) return null;
  return {
    port: `gpon-olt_${m[1]}/${m[2]}/${m[3]}`,
    shelf: +m[1], slot: +m[2], pon: +m[3], onuId: +m[4]
  };
}

function comparePorts(a, b) {
  const pa = a.match(/\d+/g).map(Number), pb = b.match(/\d+/g).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function indexBy(list) {
  const o = {};
  for (const x of list) o[x.onuIndex] = x;
  return o;
}

/**
 * `show gpon onu uncfg`
 *   OnuIndex              Sn                State
 *   gpon-onu_1/1/1:1      ZTEGC1234ABCD     unknown
 * The ":1" here is only a position in this list, NOT a free ONU id - the
 * authorise step picks a real free id on that port.
 */
function parseUncfgOnus(output) {
  const onus = [];
  for (const line of (output || '').split('\n')) {
    const m = line.match(/gpon[-_]onu[-_]?(\d+\/\d+\/\d+:\d+)\s+(\S+)\s*(\S*)/i);
    if (!m || !/^[A-Za-z0-9]{8,16}$/.test(m[2])) continue;
    const index = normaliseIndex(m[1]);
    const parts = splitPonPort(index);
    onus.push({
      onuIndex: index,
      ponPort: parts ? parts.port : '',
      serial: m[2].toUpperCase(),
      state: (m[3] || 'unknown').toLowerCase()
    });
  }
  return onus;
}

/**
 * `show gpon onu state`
 *   OnuIndex           Admin State  OMCC State  Phase State  Channel
 *   gpon-onu_1/1/1:1   enable       enable      working      1
 */
function parseOnuState(output) {
  const onus = [];
  for (const line of (output || '').split('\n')) {
    const m = line.match(/gpon[-_]onu[-_]?(\d+\/\d+\/\d+:\d+)\s+(\S+)\s+(\S+)\s+(\S+)/i);
    if (!m) continue;
    const index = normaliseIndex(m[1]);
    const parts = splitPonPort(index);
    const phase = m[4].toLowerCase();
    onus.push({
      onuIndex: index,
      ponPort: parts ? parts.port : '',
      onuId: parts ? parts.onuId : null,
      adminState: m[2].toLowerCase(),
      omccState: m[3].toLowerCase(),
      phaseState: phase,
      // `working` is the only phase that means the customer has service
      online: phase === 'working'
    });
  }
  return onus;
}

/**
 * `show gpon onu baseinfo gpon-olt_1/1/1`
 *   OnuIndex           Type        Mode   AuthInfo              State
 *   gpon-onu_1/1/1:1   ZTE-F660    sn     SN:ZTEGC1234ABCD      ready
 */
function parseOnuBaseinfo(output) {
  const onus = [];
  for (const line of (output || '').split('\n')) {
    const m = line.match(/gpon[-_]onu[-_]?(\d+\/\d+\/\d+:\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(\S*)/i);
    if (!m) continue;
    const auth = m[4];
    const sn = auth.match(/^SN:([A-Za-z0-9]{8,16})$/i) || auth.match(/^([A-Za-z0-9]{12,16})$/);
    onus.push({
      onuIndex: normaliseIndex(m[1]),
      type: m[2],
      mode: m[3].toLowerCase(),
      serial: sn ? sn[1].toUpperCase() : null,
      state: (m[5] || '').toLowerCase()
    });
  }
  return onus;
}

/**
 * `show pon power onu-rx gpon-olt_1/1/1`
 *   Onu                 Rx power
 *   gpon-onu_1/1/1:1    -20.123(dbm)
 *   gpon-onu_1/1/1:2    N/A
 */
function parseRxPowerList(output) {
  const rx = {};
  for (const line of (output || '').split('\n')) {
    const m = line.match(/gpon[-_]onu[-_]?(\d+\/\d+\/\d+:\d+)\s+(-?\d+(?:\.\d+)?)\s*\(?dbm/i);
    if (m) rx[normaliseIndex(m[1])] = parseFloat(m[2]);
  }
  return rx;
}

/** `show gpon onu detail-info <index>` - free-form "Label : value" block */
function parseOnuDetail(output) {
  const grab = (label) => {
    const re = new RegExp('^\\s*' + label + '\\s*:\\s*(.*)$', 'im');
    const m = (output || '').match(re);
    return m ? m[1].trim() : '';
  };
  return {
    name: grab('Name'),
    type: grab('Type'),
    serial: grab('Serial ?Number') || grab('SN'),
    state: grab('State'),
    adminState: grab('Admin state'),
    phaseState: grab('Phase state'),
    description: grab('Description'),
    onlineDuration: grab('Online Duration'),
    distance: grab('ONU Distance') || grab('Distance'),
    raw: output
  };
}

/**
 * `show pon power attenuation <index>`
 *   up      Rx : -19.560(dbm)   Tx : 2.410(dbm)
 *   down    Tx : 3.520(dbm)     Rx : -20.180(dbm)
 * "down Rx" is what the CUSTOMER's ONU receives - the number that matters
 * when a client complains, not the OLT-side reading.
 */
function parsePower(output) {
  const nums = [...(output || '').matchAll(/(up|down)?\s*(Rx|Tx)\s*:?\s*(-?\d+\.?\d*)\s*\(?dbm/gi)];
  const power = { oltRx: null, oltTx: null, onuRx: null, onuTx: null };
  let dir = 'up';
  for (const m of nums) {
    if (m[1]) dir = m[1].toLowerCase();
    const value = parseFloat(m[3]);
    if (dir === 'up') {
      if (/rx/i.test(m[2])) power.oltRx = value; else power.onuTx = value;
    } else {
      if (/rx/i.test(m[2])) power.onuRx = value; else power.oltTx = value;
    }
  }
  return power;
}

/** Signal grading used for the colours and the low-signal count */
function gradeSignal(rxDbm) {
  if (rxDbm === null || rxDbm === undefined || isNaN(rxDbm)) return { level: 'unknown', label: 'Sin dato' };
  if (rxDbm >= -8) return { level: 'high', label: 'Muy alta (saturada)' };
  if (rxDbm >= -25) return { level: 'good', label: 'Buena' };
  if (rxDbm >= -27) return { level: 'warn', label: 'Baja - revisar' };
  return { level: 'critical', label: 'Critica' };
}

/** First ONU id not used on that PON port (ids run 1..128 on GPON) */
function nextFreeOnuId(port, registered, alsoTaken = []) {
  const used = new Set(alsoTaken);
  for (const o of registered) {
    const p = splitPonPort(o.onuIndex);
    if (p && p.port === port) used.add(p.onuId);
  }
  for (let i = 1; i <= MAX_ONU_ID; i++) if (!used.has(i)) return i;
  return null;
}

// ========== Input validation ==========
// Every value below ends up inside a CLI line. A newline or a stray word in
// any of them would become a second command on the OLT, so they are checked
// against a strict whitelist instead of being "cleaned".

function assertIndex(onuIndex) {
  // The whole value must be an index - not merely contain one - so stray text
  // can never quietly land on some ONU
  if (!/^gpon[-_]onu[-_]?\d+\/\d+\/\d+:\d+$/i.test(String(onuIndex || '').trim())) {
    throw new Error(`Indice de ONU invalido: ${onuIndex}`);
  }
  const idx = normaliseIndex(String(onuIndex).trim());
  const p = splitPonPort(idx);
  if (!p || !/^gpon-onu_\d+\/\d+\/\d+:\d+$/.test(idx) || p.onuId < 1 || p.onuId > MAX_ONU_ID) {
    throw new Error(`Indice de ONU invalido: ${onuIndex}`);
  }
  return idx;
}

function assertSerial(sn) {
  const s = String(sn || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,16}$/.test(s)) throw new Error(`Serial invalido: ${sn}`);
  return s;
}

function assertToken(value, what, max = 32) {
  const v = String(value || '').trim();
  if (!new RegExp(`^[A-Za-z0-9_.\\-]{1,${max}}$`).test(v)) {
    throw new Error(`${what} invalido: "${value}" (solo letras, numeros, _ . - y sin espacios)`);
  }
  return v;
}

function assertVlan(v) {
  const n = parseInt(v, 10);
  if (!(n >= 1 && n <= 4094) || String(n) !== String(v).trim()) throw new Error(`VLAN invalida: ${v}`);
  return n;
}

/** "José Peña" -> "Jose_Pena": what the OLT accepts as an ONU name */
function safeOnuName(text, max = 32) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, max) || 'cliente';
}

// ========== Provisioning command builders ==========
// They return arrays of CLI lines and never execute anything: the route shows
// the operator exactly what will be sent before sending it.

/**
 * Register a serial on a PON port and give it a service path.
 * mode 'bridge'  : the ONU passes traffic to the customer's router, PPPoE stays
 *                  on the MikroTik (the current setup)
 * mode 'register': only register the ONU, configure service by hand
 */
function buildAuthorize({ port, onuId, onuType, serial, name, description, vlan,
                          tcontProfile, mode = 'bridge', ethPort = 'eth_0/1' }) {
  const p = splitPonPort(`${port}:${onuId}`);
  if (!p || !/^gpon-olt_\d+\/\d+\/\d+$/.test(port)) throw new Error(`Puerto PON invalido: ${port}`);
  const id = parseInt(onuId, 10);
  if (!(id >= 1 && id <= MAX_ONU_ID)) throw new Error(`ID de ONU invalido: ${onuId}`);
  const index = `gpon-onu_${p.shelf}/${p.slot}/${p.pon}:${id}`;
  const sn = assertSerial(serial);
  const type = assertToken(onuType, 'Tipo de ONU');
  const nm = assertToken(name, 'Nombre');
  const desc = description ? assertToken(description, 'Descripcion', 64) : null;

  const lines = [
    'configure terminal',
    `interface ${port}`,
    `onu ${id} type ${type} sn ${sn}`,
    'exit',
    `interface ${index}`,
    `name ${nm}`
  ];
  if (desc) lines.push(`description ${desc}`);

  if (mode === 'bridge') {
    const v = assertVlan(vlan);
    const tp = assertToken(tcontProfile, 'Perfil T-CONT');
    const eth = String(ethPort || '').trim();
    if (!/^eth_\d+\/\d+$/.test(eth)) throw new Error(`Puerto ETH invalido: ${ethPort}`);
    lines.push(
      `tcont 1 profile ${tp}`,
      'gemport 1 tcont 1',
      `service-port 1 vport 1 user-vlan ${v} vlan ${v}`,
      'exit',
      `pon-onu-mng ${index}`,
      `service INTERNET gemport 1 vlan ${v}`,
      `vlan port ${eth} mode tag vlan ${v}`,
      'exit'
    );
  } else {
    lines.push('exit');
  }
  lines.push('end');
  return { index, commands: lines };
}

function buildReboot(onuIndex) {
  const idx = assertIndex(onuIndex);
  return ['configure terminal', `pon-onu-mng ${idx}`, 'reboot', 'exit', 'end'];
}

function buildSetAdminState(onuIndex, enabled) {
  const idx = assertIndex(onuIndex);
  return ['configure terminal', `interface ${idx}`, enabled ? 'no shutdown' : 'shutdown', 'exit', 'end'];
}

function buildDelete(onuIndex) {
  const idx = assertIndex(onuIndex);
  const p = splitPonPort(idx);
  return ['configure terminal', `interface ${p.port}`, `no onu ${p.onuId}`, 'exit', 'end'];
}

/** Persist the running config - without this everything is lost on reboot */
const SAVE_CONFIG = ['write'];

module.exports = ZteOlt;
Object.assign(module.exports, {
  PROMPT, CLI_ERROR,
  cleanOutput, normaliseIndex, splitPonPort, comparePorts,
  parseUncfgOnus, parseOnuState, parseOnuBaseinfo, parseRxPowerList, parseOnuDetail, parsePower,
  gradeSignal, nextFreeOnuId, safeOnuName,
  assertIndex, assertSerial, assertToken, assertVlan,
  buildAuthorize, buildReboot, buildSetAdminState, buildDelete, SAVE_CONFIG
});
