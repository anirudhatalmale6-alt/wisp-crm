/**
 * Demo stand-in for lib/zte-olt.js, used until the real C300/C320 is set up.
 *
 * It does not invent parsed objects: it produces the same raw CLI text a ZXAN
 * OLT prints and feeds it through the real parsers, so the screen is exercised
 * exactly as it will be with the real OLT.
 *
 * Every serial starts with "DEMO" and every customer name says "ejemplo", so a
 * screenshot of this mode can never be mistaken for the live network.
 * Nothing here can send a command anywhere: runScript refuses.
 */
const Z = require('./zte-olt');

const PORTS = {
  'gpon-olt_1/1/1': [
    // id, type,       admin,     omcc,      phase,       rx
    [1, 'ZTE-F660',  'enable',  'enable',  'working',   -19.84],
    [2, 'ZTE-F660',  'enable',  'enable',  'working',   -21.37],
    [3, 'ZTE-F601',  'enable',  'enable',  'working',   -23.02],
    [4, 'ZTE-F670L', 'enable',  'enable',  'working',   -26.15],
    [5, 'ZTE-F660',  'enable',  'disable', 'LOS',       null],
    [6, 'ZTE-F601',  'enable',  'enable',  'working',   -18.66],
    [7, 'ZTE-F660',  'enable',  'enable',  'working',   -28.41],
    [8, 'ZTE-F670L', 'disable', 'disable', 'disable',   null],
    [10, 'ZTE-F660', 'enable',  'enable',  'working',   -22.90]
  ],
  'gpon-olt_1/1/2': [
    [1, 'ZTE-F601',  'enable',  'enable',  'working',   -20.48],
    [2, 'ZTE-F660',  'enable',  'disable', 'DyingGasp', null],
    [3, 'ZTE-F660',  'enable',  'enable',  'working',   -7.20],
    [4, 'ZTE-F670L', 'enable',  'enable',  'working',   -24.75],
    [5, 'ZTE-F601',  'enable',  'disable', 'OffLine',   null],
    [6, 'ZTE-F660',  'enable',  'enable',  'working',   -21.93]
  ]
};

const UNCFG = [
  ['gpon-onu_1/1/1:1', 'DEMO0000F660'],
  ['gpon-onu_1/1/2:1', 'DEMO0000F601'],
  ['gpon-onu_1/1/2:2', 'DEMO000F670L']
];

function serialFor(port, id) {
  const pon = port.split('/').pop();
  return `DEMO${pon.padStart(2, '0')}${String(id).padStart(6, '0')}`;
}

function pad(s, n) { return String(s).padEnd(n); }

function rawState() {
  const lines = [
    'OnuIndex             Admin State  OMCC State  Phase State  Channel',
    '-------------------------------------------------------------------'
  ];
  for (const [port, onus] of Object.entries(PORTS)) {
    const p = port.replace('gpon-olt_', '');
    for (const [id, , admin, omcc, phase] of onus) {
      lines.push(`${pad(`gpon-onu_${p}:${id}`, 21)}${pad(admin, 13)}${pad(omcc, 12)}${pad(phase, 13)}1(GPON)`);
    }
  }
  return lines.join('\n');
}

function rawBaseinfo(port) {
  const p = port.replace('gpon-olt_', '');
  const lines = [
    'OnuIndex             Type          Mode   AuthInfo              State',
    '----------------------------------------------------------------------'
  ];
  for (const [id, type, , , phase] of PORTS[port] || []) {
    lines.push(`${pad(`gpon-onu_${p}:${id}`, 21)}${pad(type, 14)}${pad('sn', 7)}${pad('SN:' + serialFor(port, id), 22)}${phase === 'working' ? 'ready' : 'offline'}`);
  }
  return lines.join('\n');
}

function rawRx(port) {
  const p = port.replace('gpon-olt_', '');
  const lines = ['Onu                    Rx power', '---------------------------------'];
  for (const [id, , , , , rx] of PORTS[port] || []) {
    lines.push(`${pad(`gpon-onu_${p}:${id}`, 23)}${rx === null ? 'N/A' : rx.toFixed(3) + '(dbm)'}`);
  }
  return lines.join('\n');
}

function rawUncfg() {
  const lines = [
    'OnuIndex                 Sn                  State',
    '---------------------------------------------------------'
  ];
  for (const [idx, sn] of UNCFG) lines.push(`${pad(idx, 25)}${pad(sn, 20)}unknown`);
  return lines.join('\n');
}

function find(onuIndex) {
  const parts = Z.splitPonPort(onuIndex);
  if (!parts) return null;
  const row = (PORTS[parts.port] || []).find(r => r[0] === parts.onuId);
  return row ? { parts, row } : null;
}

class ZteOltDemo {
  constructor() { this.demo = true; }
  isConfigured() { return true; }

  async testConnection() {
    return { success: true, model: 'C320 (DEMO)', version: 'V2.1.0', raw: 'Modo demostracion - no hay OLT conectada' };
  }

  async listAll() {
    const state = Z.parseOnuState(rawState());
    const ports = [...new Set(state.map(o => o.ponPort))].sort(Z.comparePorts);
    const base = {};
    const rx = {};
    for (const port of ports) {
      for (const b of Z.parseOnuBaseinfo(rawBaseinfo(port))) base[b.onuIndex] = b;
      Object.assign(rx, Z.parseRxPowerList(rawRx(port)));
    }
    const registered = state.map(o => ({
      ...o,
      serial: (base[o.onuIndex] || {}).serial || null,
      type: (base[o.onuIndex] || {}).type || null,
      rx: rx[o.onuIndex] !== undefined ? rx[o.onuIndex] : null
    }));
    return { registered, unconfigured: Z.parseUncfgOnus(rawUncfg()), ports };
  }

  async getOnuDetail(onuIndex) {
    const f = find(onuIndex);
    if (!f) throw new Error('ONU no encontrada');
    const [id, type, admin, , phase, rx] = f.row;
    const detail = [
      `ONU interface:          ${onuIndex}`,
      `  Name:                 cliente_ejemplo_${id}`,
      `  Type:                 ${type}`,
      `  State:                ${phase === 'working' ? 'ready' : 'offline'}`,
      `  Admin state:          ${admin}`,
      `  Phase state:          ${phase}`,
      `  Serial number:        ${serialFor(f.parts.port, id)}`,
      `  Description:          demo`,
      `  ONU Distance:         ${900 + id * 137}m`,
      `  Online Duration:      ${phase === 'working' ? `${id}d ${id + 2}h ${id * 7 % 60}m` : '0h 0m 0s'}`
    ].join('\n');
    const power = rx === null
      ? '            up      Rx :N/A               Tx:N/A\n            down    Tx :N/A               Rx:N/A'
      : `            up      Rx :${(rx + 1.7).toFixed(3)}(dbm)      Tx:2.410(dbm)\n            down    Tx :3.520(dbm)      Rx:${rx.toFixed(3)}(dbm)`;
    return { detail: Z.parseOnuDetail(detail), power: Z.parsePower(power) };
  }

  async runScript() {
    throw new Error('Modo demostracion: no hay OLT conectada, no se envio ningun comando');
  }
}

module.exports = ZteOltDemo;
