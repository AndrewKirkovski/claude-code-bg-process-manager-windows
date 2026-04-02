/**
 * Inline HTML dashboard for bg-manager.
 * Returns a complete HTML page as a string — no external files needed.
 * Uses ansi_up from CDN for ANSI color rendering.
 */
export function getUiHtml(port) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bg-manager</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --green: #3fb950; --red: #f85149;
    --blue: #58a6ff; --yellow: #d29922; --accent: #1f6feb;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); font-size: 14px; height: 100vh;
    display: flex; flex-direction: column; overflow: hidden;
  }

  /* Header */
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; background: var(--bg2); border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  header h1 { font-size: 16px; font-weight: 600; }
  header h1 span { color: var(--text2); font-weight: 400; margin-left: 8px; font-size: 13px; }
  .header-actions { display: flex; gap: 10px; align-items: center; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status-dot.connected { background: var(--green); }
  .status-dot.disconnected { background: var(--red); }

  /* Toolbar */
  .toolbar {
    display: flex; align-items: center; gap: 12px; padding: 8px 20px;
    background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  select, button {
    font-size: 13px; padding: 4px 10px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--bg3); color: var(--text);
    cursor: pointer; outline: none;
  }
  select:hover, button:hover { border-color: var(--blue); }
  button.danger { border-color: var(--red); color: var(--red); }
  button.danger:hover { background: var(--red); color: #fff; }

  /* Main layout */
  main { display: flex; flex: 1; overflow: hidden; }

  /* Process list panel */
  .panel-list {
    width: 420px; min-width: 300px; border-right: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden; flex-shrink: 0;
  }
  .panel-list-header {
    padding: 10px 16px; font-size: 12px; color: var(--text2);
    text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .panel-list-body { overflow-y: auto; flex: 1; }

  .project-group { border-bottom: 1px solid var(--border); }
  .project-name {
    padding: 8px 16px; font-size: 12px; color: var(--blue);
    background: var(--bg); font-weight: 600; position: sticky; top: 0;
    cursor: pointer;
  }
  .project-name:hover { background: var(--bg2); }

  .proc-entry {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 16px 8px 28px; cursor: pointer; border-left: 3px solid transparent;
    transition: background 0.1s;
  }
  .proc-entry:hover { background: var(--bg3); }
  .proc-entry.selected { background: var(--bg3); border-left-color: var(--blue); }
  .proc-status {
    font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;
    text-transform: uppercase; min-width: 44px; text-align: center;
  }
  .proc-status.alive { background: rgba(63,185,80,0.15); color: var(--green); }
  .proc-status.dead { background: rgba(248,81,73,0.15); color: var(--red); }
  .proc-info { flex: 1; min-width: 0; }
  .proc-name { font-weight: 600; font-size: 13px; }
  .proc-meta { font-size: 11px; color: var(--text2); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .proc-kill {
    background: none; border: none; color: var(--text2); cursor: pointer;
    font-size: 16px; padding: 2px 6px; border-radius: 4px; line-height: 1;
  }
  .proc-kill:hover { color: var(--red); background: rgba(248,81,73,0.15); }

  /* Log viewer panel */
  .panel-log { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .panel-log-header {
    padding: 10px 16px; display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid var(--border); flex-shrink: 0; min-height: 42px;
  }
  .panel-log-header .info { font-size: 13px; }
  .panel-log-header .info .name { font-weight: 600; }
  .panel-log-header .info .pid { color: var(--text2); margin-left: 8px; }
  .panel-log-controls { display: flex; gap: 8px; align-items: center; }
  .toggle-label { font-size: 12px; color: var(--text2); display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .toggle-label input { cursor: pointer; }

  .log-body {
    flex: 1; overflow-y: auto; padding: 12px 16px;
    font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
    font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all;
    background: var(--bg);
  }
  .log-body .ansi-bright-black { color: #636c76; }
  .log-empty {
    display: flex; align-items: center; justify-content: center; flex: 1;
    color: var(--text2); font-size: 14px;
  }

  /* Responsive */
  @media (max-width: 800px) {
    main { flex-direction: column; }
    .panel-list { width: 100%; max-height: 40vh; border-right: none; border-bottom: 1px solid var(--border); }
  }
</style>
</head>
<body>

<header>
  <h1>bg-manager <span>process dashboard</span></h1>
  <div class="header-actions">
    <span class="status-dot disconnected" id="statusDot" title="SSE disconnected"></span>
    <span id="statusText" style="font-size:12px;color:var(--text2)">connecting...</span>
  </div>
</header>

<div class="toolbar">
  <select id="projectFilter"><option value="">All projects</option></select>
  <button id="btnCleanup" class="danger">Cleanup dead</button>
  <span id="countLabel" style="font-size:12px;color:var(--text2)"></span>
</div>

<main>
  <div class="panel-list">
    <div class="panel-list-header">Processes</div>
    <div class="panel-list-body" id="procList"></div>
  </div>
  <div class="panel-log">
    <div class="panel-log-header">
      <div class="info" id="logInfo">
        <span style="color:var(--text2)">Select a process to view logs</span>
      </div>
      <div class="panel-log-controls">
        <label class="toggle-label"><input type="checkbox" id="autoScroll" checked> Auto-scroll</label>
      </div>
    </div>
    <div id="logContainer">
      <div class="log-empty" id="logEmpty">No process selected</div>
      <div class="log-body" id="logBody" style="display:none"></div>
    </div>
  </div>
</main>

<script>
(function() {
  // Minimal ANSI-to-HTML converter (inline, no CDN dependency)
  const ANSI_COLORS = {
    30:'#4d4d4c',31:'#c82829',32:'#718c00',33:'#eab700',34:'#4271ae',35:'#8959a8',36:'#3e999f',37:'#d6d6d6',
    90:'#636c76',91:'#f85149',92:'#3fb950',93:'#d29922',94:'#58a6ff',95:'#bc8cff',96:'#39c5cf',97:'#ffffff',
    40:'#4d4d4c',41:'#c82829',42:'#718c00',43:'#eab700',44:'#4271ae',45:'#8959a8',46:'#3e999f',47:'#d6d6d6',
    100:'#636c76',101:'#f85149',102:'#3fb950',103:'#d29922',104:'#58a6ff',105:'#bc8cff',106:'#39c5cf',107:'#ffffff'
  };
  function hasStyles(codes) {
    for (const c of codes) {
      if (c === 0) continue;
      if (c === 1 || c === 2 || c === 3 || c === 4) return true;
      if (c >= 30 && c <= 37 || c >= 90 && c <= 97) return true;
      if (c >= 40 && c <= 47 || c >= 100 && c <= 107) return true;
    }
    return false;
  }
  function ansiToHtml(text) {
    let result = '';
    let i = 0;
    let openSpans = 0;
    while (i < text.length) {
      if (text[i] === '\\x1b' || text[i] === '\\u001b' || text.charCodeAt(i) === 27) {
        const m = text.slice(i).match(/^\\x1b\\[([0-9;]*)m/i) || text.slice(i).match(/^\\u001b\\[([0-9;]*)m/i) || text.slice(i).match(/^\\x1B\\[([0-9;]*)m/);
        if (!m) { // try raw ESC
          const raw = text.slice(i).match(/^.\\[([0-9;]*)m/);
          if (raw) {
            const codes = raw[1].split(';').map(Number);
            result += buildSpan(codes, openSpans);
            if (codes.includes(0)) { openSpans = hasStyles(codes) ? 1 : 0; } else { openSpans++; }
            i += raw[0].length; continue;
          }
          result += escHtml(text[i]); i++; continue;
        }
        const codes = m[1].split(';').map(Number);
        result += buildSpan(codes, openSpans);
        if (codes.includes(0)) { openSpans = hasStyles(codes) ? 1 : 0; } else { openSpans++; }
        i += m[0].length;
      } else {
        result += escHtml(text[i]); i++;
      }
    }
    while (openSpans-- > 0) result += '</span>';
    return result;
  }
  function buildSpan(codes, openSpans) {
    let close = '';
    if (codes.includes(0) || codes.length === 0) {
      while (openSpans-- > 0) close += '</span>';
      if (codes.length <= 1 && codes[0] === 0) return close;
    }
    let styles = [];
    for (const c of codes) {
      if (c === 0) continue;
      if (c === 1) styles.push('font-weight:bold');
      else if (c === 2) styles.push('opacity:0.7');
      else if (c === 3) styles.push('font-style:italic');
      else if (c === 4) styles.push('text-decoration:underline');
      else if (c >= 30 && c <= 37 || c >= 90 && c <= 97) styles.push('color:' + ANSI_COLORS[c]);
      else if (c >= 40 && c <= 47 || c >= 100 && c <= 107) styles.push('background:' + ANSI_COLORS[c]);
    }
    return close + (styles.length ? '<span style="' + styles.join(';') + '">' : '');
  }
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  const API = 'http://127.0.0.1:${port}';

  let processes = [];
  let selected = null; // { project, name }
  let logSSE = null;

  // ── Elements ──
  const $procList = document.getElementById('procList');
  const $logBody = document.getElementById('logBody');
  const $logEmpty = document.getElementById('logEmpty');
  const $logInfo = document.getElementById('logInfo');
  const $projectFilter = document.getElementById('projectFilter');
  const $countLabel = document.getElementById('countLabel');
  const $statusDot = document.getElementById('statusDot');
  const $statusText = document.getElementById('statusText');
  const $autoScroll = document.getElementById('autoScroll');

  // ── SSE: process list ──
  let globalSSE = null;

  function connectSSE() {
    if (globalSSE) globalSSE.close();
    globalSSE = new EventSource(API + '/api/sse');

    globalSSE.addEventListener('process_list', (e) => {
      processes = JSON.parse(e.data);
      renderProcessList();
    });

    globalSSE.onopen = () => {
      $statusDot.className = 'status-dot connected';
      $statusText.textContent = 'connected';
    };

    globalSSE.onerror = () => {
      $statusDot.className = 'status-dot disconnected';
      $statusText.textContent = 'disconnected';
    };
  }

  connectSSE();

  // ── Render ──
  function renderProcessList() {
    const filter = $projectFilter.value;
    const filtered = filter ? processes.filter(p => p.project === filter) : processes;

    // Update project filter options
    const projects = [...new Set(processes.map(p => p.project))].sort();
    const currentVal = $projectFilter.value;
    $projectFilter.innerHTML = '<option value="">All projects</option>' +
      projects.map(p => '<option value="' + escHtml(p) + '"' + (p === currentVal ? ' selected' : '') + '>' + escHtml(shortProject(p)) + '</option>').join('');

    // Count
    const alive = filtered.filter(p => p.alive).length;
    const dead = filtered.length - alive;
    $countLabel.textContent = filtered.length + ' total, ' + alive + ' alive, ' + dead + ' dead';

    // Group by project
    const groups = {};
    for (const p of filtered) {
      (groups[p.project] = groups[p.project] || []).push(p);
    }

    let html = '';
    for (const [proj, procs] of Object.entries(groups)) {
      html += '<div class="project-group">';
      html += '<div class="project-name">' + escHtml(shortProject(proj)) + '</div>';
      for (const p of procs) {
        const sel = selected && selected.project === p.project && selected.name === p.name;
        const statusCls = p.alive ? 'alive' : 'dead';
        const elapsed = timeAgo(p.started_at);
        html += '<div class="proc-entry' + (sel ? ' selected' : '') + '" data-project="' + escHtml(p.project) + '" data-name="' + escHtml(p.name) + '">';
        html += '<span class="proc-status ' + statusCls + '">' + (p.alive ? 'alive' : 'dead') + '</span>';
        html += '<div class="proc-info"><div class="proc-name">' + escHtml(p.name) + '</div>';
        html += '<div class="proc-meta">PID ' + p.pid + ' &middot; ' + elapsed + ' &middot; ' + escHtml(truncate(p.command, 60)) + '</div></div>';
        html += '<button class="proc-kill" data-project="' + escHtml(p.project) + '" data-name="' + escHtml(p.name) + '" title="Kill process">&times;</button>';
        html += '</div>';
      }
      html += '</div>';
    }

    if (filtered.length === 0) {
      html = '<div style="padding:20px;text-align:center;color:var(--text2)">No processes</div>';
    }

    $procList.innerHTML = html;
  }

  // ── Events ──
  $procList.addEventListener('click', (e) => {
    // Kill button
    const killBtn = e.target.closest('.proc-kill');
    if (killBtn) {
      e.stopPropagation();
      const { project, name } = killBtn.dataset;
      if (confirm('Kill process "' + name + '"?')) {
        fetch(API + '/api/processes/' + encodeURIComponent(project) + '/' + encodeURIComponent(name) + '/kill', { method: 'POST' });
      }
      return;
    }

    // Select process
    const entry = e.target.closest('.proc-entry');
    if (entry) {
      const { project, name } = entry.dataset;
      selectProcess(project, name);
    }
  });

  $projectFilter.addEventListener('change', renderProcessList);

  document.getElementById('btnCleanup').addEventListener('click', () => {
    fetch(API + '/api/cleanup', { method: 'POST' });
  });

  // ── Log viewer ──
  function selectProcess(project, name) {
    selected = { project, name };
    renderProcessList(); // update selection highlight

    const proc = processes.find(p => p.project === project && p.name === name);
    if (!proc) return;

    $logInfo.innerHTML = '<span class="name">' + escHtml(name) + '</span>' +
      '<span class="pid">PID ' + proc.pid + '</span>' +
      '<span class="pid">' + (proc.alive ? '<span style="color:var(--green)">ALIVE</span>' : '<span style="color:var(--red)">DEAD</span>') + '</span>';

    // Fetch initial logs
    $logBody.style.display = 'block';
    $logEmpty.style.display = 'none';
    $logBody.innerHTML = '<span style="color:var(--text2)">Loading...</span>';

    fetch(API + '/api/processes/' + encodeURIComponent(project) + '/' + encodeURIComponent(name) + '/logs?lines=500')
      .then(r => r.json())
      .then(data => {
        $logBody.innerHTML = ansiToHtml(data.content || '');
        scrollLog();
        startLogStream(project, name);
      })
      .catch(() => {
        $logBody.innerHTML = '<span style="color:var(--red)">Failed to load logs</span>';
      });
  }

  function startLogStream(project, name) {
    if (logSSE) logSSE.close();

    logSSE = new EventSource(API + '/api/processes/' + encodeURIComponent(project) + '/' + encodeURIComponent(name) + '/logs/stream');

    logSSE.onmessage = (e) => {
      const text = JSON.parse(e.data);
      const html = ansiToHtml(text);
      $logBody.innerHTML += html;
      scrollLog();
    };

    logSSE.onerror = () => {
      // Stream ended (process died, file gone, etc.)
    };
  }

  function scrollLog() {
    if ($autoScroll.checked) {
      const container = $logBody.parentElement;
      // The log-body itself scrolls if it's in a flex container
      $logBody.scrollTop = $logBody.scrollHeight;
    }
  }

  // ── Helpers ──
  function shortProject(p) {
    const parts = p.replace(/\\\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }

  function truncate(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ' + (hrs % 24) + 'h ago';
  }
})();
</script>
</body>
</html>`;
}
//# sourceMappingURL=ui.js.map