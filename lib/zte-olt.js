/**
 * ZTE C320 / C300 GPON OLT driver
 *
 * Talks to the OLT the same way SmartOLT does: an interactive CLI session
 * (SSH or Telnet) for provisioning, and SNMP elsewhere for bulk reads.
 *
 * Two things make the OLT CLI different from the MikroTik one in lib/mikrotik.js:
 *   - ZTE does not support `conn.exec()`. Everything goes through a shell where
 *     you write a command and read until the prompt comes back.
 *   - Output is paged (`--More--`). Paging is disabled per-session, but the
 *     reader still answers the pager in case the OLT ignores it.
 *
 * Prompt looks like: ZXAN>  ZXAN#  ZXAN(config)#  ZXAN(config-if)#
 *
 * NOTE ON FIRMWARE: read commands below are stable across C320 firmwares.
 * The provisioning command builders at the bottom are the ones that vary
 * (especially WiFi/PPPoE on pon-onu-mng). Verify them on the real OLT with
 * the raw console before trusting them - see buildAuthorize/buildWifi notes.
 */
const net = require('net');
const { Client } = require('ssh2');

// Matches ZXAN> / ZXAN# / ZXAN(config-if)# at end of buffer
const PROMPT = /[\r\n]?[A-Za-z0-9_.\-]+(\([A-Za-z0-9_.\-]+\))?\s*[>#]\s*$/;
const MORE = /--\s*More\s*--|---- More ----|<space>/i;

class ZteOlt {
  constructor(settings) {
    this.host = settings.olt_host;
    this.user = settings.olt_user;
    this.pass = settings.olt_pass;
    // olt_transport: 'ssh' or 'telnet'. C320 often ships with telnet only.
    this.transport = (settings.olt_transport || 'ssh').toLowerCase();
    this.port = parseInt(settings.olt_port) || (this.transport === 'telnet' ? 23 : 22);
    // Some OLTs need a separate enable password; falls back to the login one
    this.enablePass = settings.olt_enable_pass || settings.olt_pass;
  }

  isConfigured() {
    return !!(this.host && this.user);
  }

  /**
   * Open a session, run every command in order, close.
   * One session for the whole batch - the C320 allows very few concurrent
   * logins, so opening one per command locks us out fast.
   *
   * Returns [{ command, output }]
   */
  async run(commands, opts = {}) {
    const list = Array.isArray(commands) ? commands : [commands];
    const session = await this._open(opts.connectTimeout || 15000);
    const results = [];
    try {
      for (const cmd of list) {
        const output = await session.send(cmd, opts.commandTimeout || 20000);
        results.push({ command: cmd, output });
      }
    } finally {
      session.close();
    }
    return results;
  }

  /** Convenience: run one command, get its output text */
  async exec(command, opts = {}) {
    const [r] = await this.run([command], opts);
    return r.output;
  }

  // ========== Session handling ==========

  _open(timeout) {
    return this.transport === 'telnet' ? this._openTelnet(timeout) : this._openSsh(timeout);
  }

  /**
   * Wraps a duplex stream into { send(cmd), close() }.
   * `send` writes the command and reads until the prompt reappears,
   * feeding the pager a space whenever `--More--` shows up.
   */
  _wrap(stream, close) {
    let buffer = '';
    let waiter = null;

    const check = () => {
      if (!waiter) return;
      if (MORE.test(buffer)) {
        // Answer the pager and strip its marker from the captured text
        buffer = buffer.replace(MORE, '');
        stream.write(' ');
        return;
      }
      if (PROMPT.test(buffer)) {
        const done = waiter;
        waiter = null;
        clearTimeout(done.timer);
        const text = buffer;
        buffer = '';
        done.resolve(text);
      }
    };

    stream.on('data', (d) => { buffer += d.toString('utf8'); check(); });

    const readUntilPrompt = (ms) => new Promise((resolve) => {
      // Resolve with whatever arrived on timeout rather than throwing:
      // a slow `show gpon onu state` on a full OLT is normal, and half
      // an answer is more useful than an exception.
      const timer = setTimeout(() => {
        waiter = null;
        const text = buffer;
        buffer = '';
        resolve(text);
      }, ms);
      waiter = { resolve, timer };
      check();
    });

    return {
      raw: stream,
      readUntilPrompt,
      async send(command, ms) {
        buffer = '';
        stream.write(command + '\r\n');
        const out = await readUntilPrompt(ms || 20000);
        return cleanOutput(out, command);
      },
      close
    };
  }

  async _prepare(session) {
    // Enter privileged mode and kill paging. Both are harmless if already set.
    await session.send('enable', 6000);
    // If the OLT asked for a password, the prompt check above already returned;
    // answering blind is safe because a stray password line is just a bad command.
    await session.send(this.enablePass || '', 6000);
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
          // Swallow the login banner before issuing anything
          await session.readUntilPrompt(5000);
          try {
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
        // ZTE firmware is old; without these the handshake fails outright
        algorithms: {
          kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
                'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group-exchange-sha256',
                'diffie-hellman-group14-sha256', 'ecdh-sha2-nistp256'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', 'aes256-cbc', '3des-cbc'],
          hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'],
          serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ssh-ed25519']
        }
      });
    });
  }

  _openTelnet(timeout) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No se pudo conectar a la OLT ${this.host}:${this.port} por Telnet`));
      }, timeout);

      // Minimal telnet: refuse every option the OLT offers so it falls back
      // to plain line mode. Without this the negotiation bytes end up in the
      // command output and every parser sees garbage.
      const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251;
      const onNegotiate = (chunk) => {
        const reply = [];
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === IAC && i + 2 < chunk.length) {
            const verb = chunk[i + 1], opt = chunk[i + 2];
            if (verb === DO || verb === DONT) reply.push(IAC, WONT, opt);
            else if (verb === WILL || verb === WONT) reply.push(IAC, DONT, opt);
            i += 2;
          }
        }
        if (reply.length) socket.write(Buffer.from(reply));
      };
      socket.on('data', onNegotiate);

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Telnet OLT: ${err.message}`));
      });

      socket.on('connect', async () => {
        clearTimeout(timer);
        const session = this._wrap(socket, () => { try { socket.end(); } catch (e) {} });

        try {
          // Telnet login is a raw prompt exchange, not an auth handshake
          const banner = await session.readUntilPrompt(6000);
          if (/user\s*name|login|username/i.test(banner)) {
            socket.write(this.user + '\r\n');
            await session.readUntilPrompt(5000);
            socket.write(this.pass + '\r\n');
            await session.readUntilPrompt(6000);
          }
          resolve(await this._prepare(session));
        } catch (e) {
          session.close();
          reject(e);
        }
      });
    });
  }

  // ========== Reads ==========

  /** ONUs the OLT sees on the fibre but that are not provisioned yet */
  async getUnconfiguredOnus() {
    const out = await this.exec('show gpon onu uncfg', { commandTimeout: 25000 });
    return parseUncfgOnus(out);
  }

  /** Every provisioned ONU with its running state */
  async getOnuState() {
    const out = await this.exec('show gpon onu state', { commandTimeout: 40000 });
    return parseOnuState(out);
  }

  async getOnuDetail(onuIndex) {
    const out = await this.exec(`show gpon onu detail-info ${onuIndex}`, { commandTimeout: 20000 });
    return parseOnuDetail(out);
  }

  /** Optical budget for one ONU: rx/tx in dBm as seen from both ends */
  async getOnuPower(onuIndex) {
    const out = await this.exec(`show pon power attenuation ${onuIndex}`, { commandTimeout: 20000 });
    return parsePower(out);
  }

  async testConnection() {
    try {
      const results = await this.run(['show version', 'show card']);
      const version = results[0].output;
      const model = (version.match(/ZXA10\s+(\S+)/i) || [])[1] || '';
      return {
        success: true,
        model: model || 'ZTE OLT',
        version: (version.match(/Version[:\s]+(\S+)/i) || [])[1] || '',
        raw: results.map(r => `--- ${r.command} ---\n${r.output}`).join('\n')
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

// ========== Output parsing ==========

/** Strip the echoed command, the trailing prompt and any control noise */
function cleanOutput(text, command) {
  let t = text
    .replace(/\[[0-9;?]*[a-zA-Z]/g, '') // ANSI escapes
    .replace(/[\b]/g, '')
    .replace(/\r/g, '');
  const lines = t.split('\n');
  if (command && lines.length && lines[0].trim().endsWith(command.trim())) lines.shift();
  // Drop the prompt the OLT printed after finishing
  while (lines.length && PROMPT.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

/** Normalise gpon_onu-1/1/1:1 and gpon-onu_1/1/1:1 to one form */
function normaliseIndex(raw) {
  const m = raw.match(/(\d+)\/(\d+)\/(\d+):(\d+)/);
  return m ? `gpon-onu_${m[1]}/${m[2]}/${m[3]}:${m[4]}` : raw;
}

function splitPonPort(onuIndex) {
  const m = onuIndex.match(/(\d+)\/(\d+)\/(\d+):(\d+)/);
  if (!m) return null;
  return {
    port: `gpon-olt_${m[1]}/${m[2]}/${m[3]}`,
    shelf: +m[1], slot: +m[2], pon: +m[3], onuId: +m[4]
  };
}

/**
 * `show gpon onu uncfg`
 *   OnuIndex              Sn                State
 *   gpon-onu_1/1/1:1      ZTEGC1234ABCD     unknown
 * Column widths and the index separator move between firmwares, so match on
 * the shape of the tokens rather than on fixed positions.
 */
function parseUncfgOnus(output) {
  const onus = [];
  for (const line of (output || '').split('\n')) {
    const m = line.match(/gpon[-_]onu[-_]?(\d+\/\d+\/\d+:\d+)\s+(\S+)\s*(\S*)/i);
    if (!m) continue;
    const index = normaliseIndex(m[1]);
    const parts = splitPonPort(index);
    onus.push({
      onuIndex: index,
      ponPort: parts ? parts.port : '',
      onuId: parts ? parts.onuId : null,
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

/** `show gpon onu detail-info <index>` - free-form "Label : value" block */
function parseOnuDetail(output) {
  const detail = {};
  const grab = (label) => {
    const re = new RegExp(label + '\\s*:\\s*(.+)', 'i');
    const m = (output || '').match(re);
    return m ? m[1].trim() : '';
  };
  detail.name = grab('Name');
  detail.type = grab('Type');
  detail.serial = grab('SerialNumber') || grab('SN');
  detail.state = grab('State');
  detail.description = grab('Description');
  detail.onlineDuration = grab('Online Duration');
  detail.distance = grab('ONU Distance') || grab('Distance');
  detail.lastOfflineReason = grab('Last dying gasp') || grab('Authpass Time');
  detail.raw = output;
  return detail;
}

/**
 * `show pon power attenuation <index>`
 *   up      Rx : -19.560(dbm)   Tx : 2.410(dbm)
 *   down    Rx : -20.180(dbm)   Tx : 3.520(dbm)
 * "down Rx" is the level the CUSTOMER's ONU receives - that is the number
 * that matters when a client complains, not the OLT-side reading.
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

/** Signal grading used for the dashboard colour and the low-signal alert */
function gradeSignal(rxDbm) {
  if (rxDbm === null || rxDbm === undefined || isNaN(rxDbm)) return { level: 'unknown', label: 'Sin dato' };
  if (rxDbm >= -8) return { level: 'high', label: 'Muy alta (saturada)' };
  if (rxDbm >= -25) return { level: 'good', label: 'Buena' };
  if (rxDbm >= -27) return { level: 'warn', label: 'Baja - revisar' };
  return { level: 'critical', label: 'Critica' };
}

// ========== Provisioning command builders ==========
//
// These return arrays of CLI lines. They are NOT executed here on purpose:
// the routes show the operator exactly what will be sent before sending it,
// and every one of these is firmware-sensitive. Verify against the real OLT
// with the raw console before wiring a one-click button to them.

function buildAuthorize({ onuIndex, onuType, serial, name, description, vlan,
                          tcontProfile = 'default', gemport = 1 }) {
  const parts = splitPonPort(onuIndex);
  if (!parts) throw new Error(`Indice de ONU invalido: ${onuIndex}`);
  return [
    'configure terminal',
    `interface ${parts.port}`,
    `onu ${parts.onuId} type ${onuType} sn ${serial}`,
    'exit',
    `interface ${onuIndex}`,
    `name ${name}`,
    description ? `description ${description}` : null,
    `tcont 1 profile ${tcontProfile}`,
    `gemport ${gemport} tcont 1`,
    `service-port 1 vport 1 user-vlan ${vlan} vlan ${vlan}`,
    'exit',
    'end'
  ].filter(Boolean);
}

/** Bridge mode: ONU hands the PPPoE session straight to the MikroTik */
function buildBridge({ onuIndex, vlan, gemport = 1, ethPort = 'eth_0/1' }) {
  return [
    'configure terminal',
    `pon-onu-mng ${onuIndex}`,
    `service INTERNET gemport ${gemport} vlan ${vlan}`,
    `vlan port ${ethPort} mode tag vlan ${vlan}`,
    'exit',
    'end'
  ];
}

/** Router mode: the ONU itself dials PPPoE. Syntax varies most here. */
function buildPppoe({ onuIndex, username, password, vlan, gemport = 1 }) {
  return [
    'configure terminal',
    `pon-onu-mng ${onuIndex}`,
    `service INTERNET gemport ${gemport} vlan ${vlan}`,
    `wan-ip ipv4 mode pppoe username ${username} password ${password} vlan-profile INTERNET host 1`,
    'exit',
    'end'
  ];
}

/** WiFi on ZTE F660/F670L. Third-party ONUs answer a different dialect. */
function buildWifi({ onuIndex, ssid, key, radio = 1, ssidIndex = 1 }) {
  return [
    'configure terminal',
    `pon-onu-mng ${onuIndex}`,
    `wifi ${radio} switch on`,
    `ssid ${ssidIndex} ctrl name ${ssid}`,
    `ssid ${ssidIndex} auth wpa wpa2-psk ${key} aes`,
    `ssid ${ssidIndex} ctrl switch on`,
    'exit',
    'end'
  ];
}

function buildReboot(onuIndex) {
  return ['configure terminal', `pon-onu-mng ${onuIndex}`, 'reboot', 'exit', 'end'];
}

function buildSetAdminState(onuIndex, enabled) {
  return ['configure terminal', `interface ${onuIndex}`, enabled ? 'no shutdown' : 'shutdown', 'exit', 'end'];
}

function buildDelete(onuIndex) {
  const parts = splitPonPort(onuIndex);
  if (!parts) throw new Error(`Indice de ONU invalido: ${onuIndex}`);
  return ['configure terminal', `interface ${parts.port}`, `no onu ${parts.onuId}`, 'exit', 'end'];
}

/** Persist the running config - without this everything is lost on reboot */
const SAVE_CONFIG = ['write'];

module.exports = ZteOlt;
module.exports.parseUncfgOnus = parseUncfgOnus;
module.exports.parseOnuState = parseOnuState;
module.exports.parseOnuDetail = parseOnuDetail;
module.exports.parsePower = parsePower;
module.exports.gradeSignal = gradeSignal;
module.exports.splitPonPort = splitPonPort;
module.exports.normaliseIndex = normaliseIndex;
module.exports.cleanOutput = cleanOutput;
module.exports.buildAuthorize = buildAuthorize;
module.exports.buildBridge = buildBridge;
module.exports.buildPppoe = buildPppoe;
module.exports.buildWifi = buildWifi;
module.exports.buildReboot = buildReboot;
module.exports.buildSetAdminState = buildSetAdminState;
module.exports.buildDelete = buildDelete;
module.exports.SAVE_CONFIG = SAVE_CONFIG;
