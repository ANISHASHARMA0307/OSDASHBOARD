/* server.cjs - improved version with fixed battery detection + GPU handling */
const express = require('express');
const si = require('systeminformation');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, 'resource.log');

let thresholds = { cpu: 90, ram: 85, battery: 15 };

// Async append log (non-blocking)
function appendLogAsync(line) {
  fs.appendFile(LOG_FILE, line + '\n', (err) => {
    if (err) console.error('Failed to append log:', err);
  });
}

/* ===================== /api/stats ===================== */
app.get('/api/stats', async (req, res) => {
  try {
    const [cpuLoad, mem, battery, fsSize, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.battery(),
      si.fsSize(),
      si.graphics()
    ]);

    const cpu = Number(cpuLoad.currentLoad?.toFixed?.(2) ?? 0);
    const ram = Number((((mem?.active ?? 0) / (mem?.total ?? 1)) * 100).toFixed(2));

    // ✅ fixed battery detection logic
    const batteryPct = typeof battery?.percent === 'number' ? battery.percent : null;
    const isCharging = battery?.ischarging ?? false;

    const ssd = (fsSize || []).map(d => ({
      fs: d.fs, mount: d.mount, size: d.size, used: d.used, use: d.use
    }));

    const gpu = (graphics?.controllers || []).map(g => ({
      model: g.model || 'Unknown GPU',
      vendor: g.vendor || '',
      vram: g.vram || 0,
      utilizationGpu: g.utilizationGpu ?? null
    }));

    res.json({ cpu, ram, battery: batteryPct, isCharging, ssd, gpu });
  } catch (err) {
    console.error('/api/stats error', err);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== /api/processes ===================== */
app.get('/api/processes', async (req, res) => {
  try {
    const procInfo = await si.processes();
    const list = procInfo?.list || [];

    const safeNum = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

    const mapped = list.map(p => ({
      pid: p.pid ?? null,
      name: p.name ?? p.command ?? 'unknown',
      cpu: Math.round(safeNum(p.pcpu ?? p.cpu) * 100) / 100,
      mem: Math.round(safeNum(p.pmem ?? p.mem) * 100) / 100
    }));

    const top = mapped.sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    res.json(top);
  } catch (err) {
    console.error('/api/processes error', err);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== /api/logs ===================== */
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const n = parseInt(req.query.n, 10) || 200;
    const all = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
    res.json(all.slice(-n));
  } catch (err) {
    console.error('/api/logs error', err);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== /api/snapshot ===================== */
app.get('/api/snapshot', async (req, res) => {
  try {
    const fmt = (req.query.fmt || 'csv').toLowerCase();
    const [stats, mem, battery, procs] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.battery(),
      si.processes()
    ]);

    const time = new Date().toISOString();
    const cpuVal = Number(stats.currentLoad?.toFixed?.(2) ?? 0);
    const ramVal = Number((((mem?.active ?? 0) / (mem?.total ?? 1)) * 100).toFixed(2));
    const batteryVal = typeof battery?.percent === 'number' ? battery.percent : 'N/A';
    const topProcs = (procs?.list || [])
      .sort((a, b) => (b.pcpu ?? b.cpu ?? 0) - (a.pcpu ?? a.cpu ?? 0))
      .slice(0, 10);

    if (fmt === 'pdf') {
      res.setHeader('Content-disposition', 'attachment; filename=dash-snapshot.pdf');
      res.setHeader('Content-type', 'application/pdf');
      const doc = new PDFDocument();
      doc.pipe(res);
      doc.fontSize(16).text('OS Dashboard Snapshot', { underline: true });
      doc.moveDown();
      doc.text(`Time: ${time}`);
      doc.text(`CPU: ${cpuVal}%`);
      doc.text(`RAM: ${ramVal}%`);
      doc.text(`Battery: ${batteryVal}%`);
      doc.text(`Charging: ${battery?.ischarging ? 'Yes' : 'No'}`);
      doc.moveDown();
      doc.text('Top processes (sample):');
      topProcs.forEach(p =>
        doc.text(`${p.pid} ${p.name} — CPU:${p.pcpu ?? p.cpu ?? 0}% MEM:${p.pmem ?? p.mem ?? 0}%`)
      );
      doc.end();
      return;
    } else {
      let csv = `time,cpu%,ram%,battery%,charging\n`;
      csv += `${time},${cpuVal},${ramVal},${batteryVal},${battery?.ischarging ? 'Yes' : 'No'}\n\n`;
      csv += `pid,name,cpu,mem\n`;
      topProcs.forEach(p => {
        csv += `${p.pid},"${(p.name || '').replace(/"/g, '""')}",${p.pcpu ?? p.cpu ?? 0},${p.pmem ?? p.mem ?? 0}\n`;
      });
      res.setHeader('Content-disposition', 'attachment; filename=dash-snapshot.csv');
      res.setHeader('Content-type', 'text/csv');
      res.send(csv);
      return;
    }
  } catch (err) {
    console.error('/api/snapshot error', err);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== /api/thresholds ===================== */
app.get('/api/thresholds', (req, res) => res.json(thresholds));
app.post('/api/thresholds', (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.cpu === 'number') thresholds.cpu = b.cpu;
    if (typeof b.ram === 'number') thresholds.ram = b.ram;
    if (typeof b.battery === 'number') thresholds.battery = b.battery;
    res.json({ success: true, thresholds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===================== CRON (every minute) ===================== */
cron.schedule('* * * * *', async () => {
  try {
    const [cpu, mem, battery] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.battery()
    ]);
    const cpuVal = Number(cpu.currentLoad?.toFixed?.(2) ?? 0);
    const ramVal = Number((((mem?.active ?? 0) / (mem?.total ?? 1)) * 100).toFixed(2));
    const battVal = typeof battery?.percent === 'number' ? battery.percent : 'N/A';
    const charging = battery?.ischarging ? 'Yes' : 'No';
    const line = `[${new Date().toLocaleString()}] CPU:${cpuVal}% RAM:${ramVal}% Battery:${battVal}% Charging:${charging}`;
    appendLogAsync(line);
  } catch (err) {
    console.error('cron error', err);
  }
});

/* ===================== Serve index ===================== */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));

