// === app.js (full) ===

const logEl = document.getElementById('log');        // <pre id="log">
const canvas = document.getElementById('chart');     // <canvas id="chart">
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnCsv = document.getElementById('btnCsv');
const hzNum = document.getElementById('hzNum');      // <input id="hzNum" type="number">
const yMaxInput = document.getElementById('yMax');   // <input id="yMax" ...> 既存なら
const xSpanInput = document.getElementById('xSpan'); // <input id="xSpan" ...> 既存なら

let port, reader, writer;
let reading = false;
let deviceReady = false;
let wantRunning = false;
let lastHz = 50;

const records = []; // {tMs, distMm}
const MAX_POINTS = 10000;

// Chart.js セットアップ
const ctx = canvas.getContext('2d');
const chart = new Chart(ctx, {
  type: 'line',
  data: {
    datasets: [{
      label: 'Distance [cm]',
      data: [],           // {x: seconds, y: cm}
      pointRadius: 0,
      borderWidth: 1,
      tension: 0
    }]
  },
  options: {
    animation: false,
    responsive: true,
    parsing: false,
    scales: {
      x: {
        type: 'linear',
        title: { text: 'Time [s]', display: true }
      },
      y: {
        beginAtZero: true,
        suggestedMax: 100, // 初期 100 cm
        title: { text: 'Distance [cm]', display: true }
      }
    },
    plugins: { legend: { display: false } }
  }
});

function log(s) {
  if (!logEl) return;
  logEl.textContent += s + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

// CSV 生成
function toCSV(rows) {
  const header = 't_ms,dist_mm\n';
  return header + rows.map(r => `${r.tMs},${r.distMm}`).join('\n');
}

// 行単位デコーダ
class LineBreakTransformer {
  constructor() { this.chunks = ''; }
  transform(chunk, controller) {
    this.chunks += chunk;
    const lines = this.chunks.split(/\r?\n/);
    this.chunks = lines.pop();
    for (const line of lines) controller.enqueue(line);
  }
  flush(controller) {
    if (this.chunks) controller.enqueue(this.chunks);
  }
}

async function sendLine(line) {
  if (!writer) return;
  const data = new TextEncoder().encode(line + '\n');
  await writer.write(data);
  log(`# ${line}`);
}

function updateChartAutoAxis() {
  // X 軸: 表示幅の自動調整（初期 10s）
  const spanSec = Number(xSpanInput?.value) || 10;
  const nowSec = records.length ? records[records.length - 1].tMs / 1000 : 0;
  chart.options.scales.x.min = Math.max(0, nowSec - spanSec);
  chart.options.scales.x.max = Math.max(spanSec, nowSec);

  // Y 軸: 初期 100cm、超えたら自動拡大
  const userYMax = Number(yMaxInput?.value) || 100;
  const latestCm = records.length ? records[records.length - 1].distMm / 10 : 0;
  const currentMax = chart.options.scales.y.suggestedMax ?? 100;
  const target = Math.max(userYMax, latestCm * 1.1);
  chart.options.scales.y.suggestedMax = Math.max(currentMax, Math.ceil(target));
}

function pushPoint(tMs, distMm) {
  records.push({ tMs, distMm });
  if (records.length > MAX_POINTS) records.shift();
  chart.data.datasets[0].data.push({ x: tMs / 1000, y: distMm / 10 });
  if (chart.data.datasets[0].data.length > MAX_POINTS) chart.data.datasets[0].data.shift();
  updateChartAutoAxis();
  chart.update('none');
}

async function startReaderLoop() {
  const textDecoder = new TextDecoderStream();
  const transform = new TransformStream(new LineBreakTransformer());
  reader = port.readable
    .pipeThrough(textDecoder)
    .pipeThrough(transform)
    .getReader();

  try {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      // ブートメッセージは捨てる
      if (value.startsWith('ESP-ROM:')) continue;

      if (value.startsWith('#')) {
        log(value);
        if (value.indexOf('# READY') === 0) {
          deviceReady = true;
          if (wantRunning) {
            await sendLine(`START hz=${lastHz}`);
          }
        }
        continue;
      }

      // データ行 "t_ms,dist_mm"
      const m = value.match(/^(\d+)\s*,\s*(\d+)/);
      if (m) {
        const t = Number(m[1]);
        const d = Number(m[2]);
        pushPoint(t, d);
      }
    }
  } catch (e) {
    log(`# read error: ${e}`);
  } finally {
    try { await reader?.cancel(); } catch {}
    reader = null;
  }
}

btnConnect?.addEventListener('click', async () => {
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200, flowControl: 'none' });

    // ★ 自動リセット対策：DTR/RTS を下げたまま固定
    if (port.setSignals) {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    }
    // デバイス起動待ち
    await new Promise(r => setTimeout(r, 300));

    writer = port.writable.getWriter();
    reading = true;
    deviceReady = false;
    wantRunning = false;
    records.length = 0;
    chart.data.datasets[0].data = [];
    chart.update('none');

    log('# connected');
    startReaderLoop();

    // 起動確認
    await sendLine('HELP');

  } catch (e) {
    alert('Serial接続に失敗: ' + e);
  }
});

btnDisconnect?.addEventListener('click', async () => {
  wantRunning = false;
  reading = false;
  try { if (reader) await reader.cancel(); } catch {}
  try { if (writer) { writer.releaseLock(); writer = null; } } catch {}
  try { if (port) await port.close(); } catch {}
  port = null;
  log('# disconnected');
});

btnStart?.addEventListener('click', async () => {
  if (!port) { alert('先にConnectしてください'); return; }
  lastHz = Number(hzNum.value) || 50;
  wantRunning = true;
  if (deviceReady) {
    await sendLine(`START hz=${lastHz}`);
  } else {
    // READY が来たら自動で START する
    log('# waiting READY...');
  }
});

btnStop?.addEventListener('click', async () => {
  wantRunning = false;
  if (writer) await sendLine('STOP');
});

btnCsv?.addEventListener('click', () => {
  const csv = toCSV(records);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vl53l0x_log.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// Feature detection
if (!('serial' in navigator)) {
  alert('このブラウザはWeb Serialに対応していません。Chrome/Edge系の最新ブラウザをHTTPSでお試しください。');
}
