// Best-effort peak memory tracking for a child process.
//
// Windows: a single long-lived PowerShell loop samples the OS-maintained
//   PeakWorkingSet64 / PeakPagedMemorySize64 counters. Because those are peak
//   counters kept by the kernel, sampling once a second only misses growth in
//   the final second before exit.
// Linux:   reads VmHWM (kernel-maintained peak RSS) from /proc/<pid>/status.
// macOS:   polls `ps -o rss=` (current RSS; peak is the max of samples).
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';

export function startMemoryMonitor(pid, intervalMs = 1000) {
  const state = { method: null, peakRssBytes: 0, peakPrivateBytes: 0, samples: 0, error: null };
  let stop = () => {};

  const record = (rss, priv) => {
    state.samples++;
    if (rss > state.peakRssBytes) state.peakRssBytes = rss;
    if (priv > state.peakPrivateBytes) state.peakPrivateBytes = priv;
  };

  if (process.platform === 'win32') {
    state.method = 'windows-PeakWorkingSet64';
    const script =
      `$ErrorActionPreference='SilentlyContinue';` +
      `while ($true) { $p = Get-Process -Id ${pid}; if (-not $p) { break };` +
      ` Write-Output ("{0} {1}" -f $p.PeakWorkingSet64, $p.PeakPagedMemorySize64);` +
      ` Start-Sleep -Milliseconds ${intervalMs} }`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let partial = '';
    ps.stdout.on('data', (d) => {
      partial += d.toString();
      const lines = partial.split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) {
        const [a, b] = l.trim().split(/\s+/).map(Number);
        if (Number.isFinite(a)) record(a, Number.isFinite(b) ? b : 0);
      }
    });
    ps.on('error', (e) => { state.error = String(e); });
    stop = () => { try { ps.kill(); } catch { /* already gone */ } };
  } else if (process.platform === 'linux') {
    state.method = 'linux-VmHWM';
    const t = setInterval(() => {
      try {
        const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const hwm = /VmHWM:\s+(\d+) kB/.exec(txt);
        const peak = /VmPeak:\s+(\d+) kB/.exec(txt);
        record(hwm ? Number(hwm[1]) * 1024 : 0, peak ? Number(peak[1]) * 1024 : 0);
      } catch { /* process exited */ }
    }, intervalMs);
    stop = () => clearInterval(t);
  } else {
    state.method = 'ps-rss-poll';
    const t = setInterval(() => {
      try {
        const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
        record(Number(out.trim()) * 1024, 0);
      } catch { /* process exited */ }
    }, intervalMs);
    stop = () => clearInterval(t);
  }

  return {
    stop() { stop(); return { ...state }; },
    get state() { return { ...state }; },
  };
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}
