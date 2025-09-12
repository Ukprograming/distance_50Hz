// --- DOM ---
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnCsv = document.getElementById('btnCsv');
const btnClear = document.getElementById('btnClear');
const btnRate = document.getElementById('btnRate');
const hzNum = document.getElementById('hzNum');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const tbody = document.querySelector('#tbl tbody');
const chartCanvas = document.getElementById('chart');

// --- State ---
let port = null;
let reader = null;
let writer = null;
let reading = false;
let t0 = 0;
const records = []; // {t, mm}

// --- Chart setup ---
const INITIAL_Y_MAX = 1000;   // 100 cm
const INITIAL_X_SPAN = 10000; // 10 s
const chart = new Chart(chartCanvas.getContext('2d'), {
  type: 'line',
  data: {
    datasets: [{
      label: 'Distance (mm)',
      data: [],           // {x: time_ms, y: distance_mm}
      borderWidth: 1,
      pointRadius: 0,
      tension: 0
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    normalized: true,
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: 'Time (ms)' },
        min: 0,
        max: INITIAL_X_SPAN
      },
      y: {
        title: { display: true, text: 'Distance (mm)' },
        min: 0,
        max: INITIAL_Y_MAX
      }
    },
    plugins: { legend: { display: true } }
  }
});
const MAX_POINTS = 2000; // 約40秒@50Hz
let chartTimer = null;
function startChartTimer() {
  if (chartTimer) return;
  chartTimer = setInterval(() => chart.update('none'), 100); // 10Hzで再描画
}
function stopChartTimer() {
  if (!chartTimer) return;
  clearInterval(chartTimer);
  chartTimer = null;
}

// --- Utils ---
function log(msg) {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  logEl.textContent += (logEl.textContent ? "\n" : "") + msg;
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(s) { statusEl.textContent = s; }

async function sendLine(line) {
  if (!writer) throw new Error('writer not ready');
  const data = new TextEncoder().encode(line + '\n');
  await writer.write(data);
}

function niceCeil(v, stepCandidates = [100, 200, 250, 500, 1000, 2000, 5000]) {
  for (const step of stepCandidates) {
    const n = Math.ceil(v / step) * step;
    if (n >= v) return n;
  }
  // 最後まで来たら最大ステップで丸め
  const last = stepCandidates[stepCandidates.length - 1];
  return Math.ceil(v / last) * last;
}

function ensureAxes(t, mm) {
  const x = chart.options.scales.x;
  const y = chart.options.scales.y;

  // 横軸：10s刻みで伸ばす
  if (t > x.max) {
    const blocks = Math.ceil(t / INITIAL_X_SPAN);
    x.max = blocks * INITIAL_X_SPAN;
    // スライディングウィンドウにしたい場合は次行を有効化:
    // x.min = x.max - INITIAL_X_SPAN;
  }

  // 縦軸：超えたら「見やすい段階」で拡張（100/200/250/500/1000…）
  if (mm > y.max) {
    y.max = niceCeil(mm);
  }
}

function addRecord(t, mm) {
  records.push({ t, mm });

  // 表
  const tr = document.createElement('tr');
  const tdT = document.createElement('td');
  tdT.style.textAlign = 'left';
  tdT.textContent = String(t);
  const tdV = document.createElement('td');
  tdV.textContent = String(mm);
  tr.appendChild(tdT); tr.appendChild(tdV);
  tbody.appendChild(tr);
  if (records.length > 5000) {
    records.splice(0, records.length - 5000);
    while (tbody.rows.length > 5000) tbody.deleteRow(0);
  }

  // グラフ
  const ds = chart.data.datasets[0].data;
  ds.push({ x: t, y: mm });
  if (ds.length > MAX_POINTS) ds.splice(0, ds.length - MAX_POINTS);

  // 軸調整
  ensureAxes(t, mm);
}

function toCSV(list) {
  const lines = ['time_ms,distance_mm'];
  for (const r of list) lines.push(`${r.t},${r.mm}`);
  return lines.join('\n');
}

function parseLine(line) {
  // Arduino 側: 計測値は素の mm（整数）。メタは "# ..."
  if (!line) return;
  if (line.startsWith('#')) { log(line); return; }
  const v = Number(line.trim());
  if (Number.isFinite(v)) {
    const t = Math.round(performance.now() - t0);
    addRecord(t, v);
  } else {
    log(line);
  }
}

// --- Reader loop ---
async function startReading() {
  if (!port) return;
  reading = true;
  t0 = performance.now();

  const textDecoder = new TextDecoderStream();
  const readableClosed = port.readable.pipeTo(textDecoder.writable).catch(() => {});
  reader = textDecoder.readable.getReader();

  let buf = '';
  try {
    while (reading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buf += value;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          parseLine(line);
        }
      }
    }
  } catch (e) {
    log('read error: ' + e);
  } finally {
    try { reader.releaseLock(); } catch {}
    reader = null;
    await readableClosed;
  }
}

// --- Event handlers ---
btnConnect.addEventListener('click', async () => {
  if (!('serial' in navigator)) {
    alert('このブラウザは Web Serial に非対応です。Chrome/Edge（デスクトップ）を HTTPS で利用してください。');
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    setStatus('Connected');
    log('# connected');
  } catch (e) {
    alert('Serial接続に失敗: ' + e);
  }
});

btnDisconnect.addEventListener('click', async () => {
  reading = false;
  try { if (reader) await reader.cancel(); } catch {}
  try { if (writer) { writer.releaseLock(); writer = null; } } catch {}
  try { if (port) await port.close(); } catch {}
  port = null;
  stopChartTimer();
  setStatus('Not connected');
  log('# disconnected');
});

btnStart.addEventListener('click', async () => {
  if (!port || !writer) { alert('先にConnectしてください'); return; }
  const hz = Math.min(Math.max(Number(hzNum.value) || 50, 1), 50);
  await sendLine(`START hz=${hz}`);
  log(`# START hz=${hz}`);
  startReading();
  startChartTimer();
});

btnStop.addEventListener('click', async () => {
  try { await sendLine('STOP'); } catch {}
  reading = false;
  stopChartTimer();
  log('# STOP sent');
});

btnRate.addEventListener('click', async () => {
  const hz = Math.min(Math.max(Number(hzNum.value) || 50, 1), 50);
  await sendLine(`RATE hz=${hz}`);
  log(`# RATE hz=${hz}`);
});

btnCsv.addEventListener('click', () => {
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

btnClear.addEventListener('click', () => {
  records.length = 0;
  tbody.innerHTML = '';
  logEl.textContent = '';
  chart.data.datasets[0].data = [];
  chart.options.scales.x.min = 0;
  chart.options.scales.x.max = INITIAL_X_SPAN;
  chart.options.scales.y.min = 0;
  chart.options.scales.y.max = INITIAL_Y_MAX;
  chart.update('none');
});
