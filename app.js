// ===== app.js =====

// DOM
const canvas = document.getElementById('chart');
const statusEl = document.getElementById('status');
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnCsv = document.getElementById('btnCsv');
const hzNum = document.getElementById('hzNum');
const logEl = document.getElementById('log'); // 画面には非表示

// 状態
let port, reader, writer;
let reading = false;
let deviceReady = false;
let wantRunning = false;
let lastHz = 50;

// 記録（CSV用）
const records = []; // {tMs, distMm}
const MAX_POINTS = 10000;

// 軸の初期条件
const X_SPAN_DEFAULT_SEC = 10;   // 横軸 初期 10s（自動スライド）
const Y_INIT_MAX_CM = 100;       // 縦軸 初期 100cm（超えたら自動拡大）

// Chart.js
const ctx = canvas.getContext('2d');
const chart = new Chart(ctx, {
  type: 'line',
  data: {
    datasets: [{
      label: 'Distance [cm]',
      data: [], // {x: seconds, y: cm}
      pointRadius: 0,
      borderWidth: 1,
      tension: 0
    }]
  },
  options: {
    animation: false,
    responsive: true,
    maintainAspectRatio: false, // 親要素(#wrap)の高さに合わせる
    parsing: false,
    scales: {
      x: {
        type: 'linear',
        title: { text: 'Time [s]', display: true },
        min: 0,
        max: X_SPAN_DEFAULT_SEC
      },
      y: {
        beginAtZero: true,
        suggestedMax: Y_INIT_MAX_CM,
        title: { text: 'Distance [cm]', display: true }
      }
    },
    plugins: { legend: { display: false } }
  }
});

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg ?? '';
}
function logDebug(s) {
  if (!logEl) return;
  logEl.textContent += s + '\n';
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
  // 送ったコマンドは画面には出さない
  logDebug('# ' + line);
}

function updateChartAutoAxis() {
  const data = chart.data.datasets[0].data;
  if (data.length === 0) return;

  const nowSec = data[data.length - 1].x;
  // 横軸は最新から既定幅だけ表示
  chart.options.scales.x.min = Math.max(0, nowSec - X_SPAN_DEFAULT_SEC);
  chart.options.scales.x.max = Math.max(X_SPAN_DEFAULT_SEC, nowSec);

  // 縦軸は 100cm を基準に、越えたら自動拡大
  const latestCm = data[data.length - 1].y;
  const curMax = chart.options.scales.y.suggestedMax ?? Y_INIT_MAX_CM;
  const target = Math.max(Y_INIT_MAX_CM, Math.ceil(latestCm * 1.1));
  chart.options.scales.y.suggestedMax = Math.max(curMax, target);
}

function pushPoint(tMs, distMm) {
  records.push({ tMs, distMm });
  if (records.length > MAX_POINTS) records.shift();

  const point = { x: tMs / 1000, y: distMm / 10 };
  const arr = chart.data.datasets[0].data;
  arr.push(point);
  if (arr.length > MAX_POINTS) arr.shift();

  updateChartAutoAxis();
  chart.update('none'); // アニメなし即時更新
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

      // ブートメッセージは無視（画面にも出さない）
      if (value.startsWith('ESP-ROM:')) continue;

      // ステータス行（# で始まる）だけ小さく状態表示
      if (value.startsWith('#')) {
        logDebug(value);
        if (value.indexOf('# READY') === 0) {
          deviceReady = true;
          setStatus('READY');
          if (wantRunning) await sendLine(`START hz=${lastHz}`);
        } else if (value.indexOf('# START') === 0) {
          setStatus(`RUNNING @ ${lastHz} Hz`);
        } else if (value.indexOf('# STOP') === 0) {
          setStatus('STOPPED');
        }
        continue; // 数値は描画のみでログには出さない
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
    logDebug('# read error: ' + e);
  } finally {
    try { await reader?.cancel(); } catch {}
    reader = null;
  }
}

btnConnect?.addEventListener('click', async () => {
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200, flowControl: 'none' });

    // 自動リセット対策：DTR/RTS を下げたまま
    if (port.setSignals) {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    }

    writer = port.writable.getWriter();
    reading = true;
    deviceReady = false;
    wantRunning = false;
    records.length = 0;
    chart.data.datasets[0].data = [];
    chart.update('none');
    setStatus('CONNECTING…');

    startReaderLoop();
    // ハンドシェイク
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
  setStatus('DISCONNECTED');
});

btnStart?.addEventListener('click', async () => {
  if (!port) { alert('先にConnectしてください'); return; }
  lastHz = Number(hzNum.value) || 50;
  wantRunning = true;
  if (deviceReady) {
    await sendLine(`START hz=${lastHz}`);
  } else {
    setStatus('WAITING READY…');
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

// ブラウザ対応チェック
if (!('serial' in navigator)) {
  alert('このブラウザはWeb Serialに対応していません。Chrome/Edge の最新を HTTPS でご利用ください。');
}
