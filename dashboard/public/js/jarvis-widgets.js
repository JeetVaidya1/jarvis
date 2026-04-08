/**
 * Jarvis-specific widget definitions for LobsterBoard
 * Registers into the global WIDGETS registry from widgets.js
 */

// ─────────────────────────────────────────────
// Shared Jarvis SSE connection for all Jarvis widgets
// ─────────────────────────────────────────────
let _jarvisSource = null;
let _jarvisCallbacks = [];

function onJarvisStream(callback) {
  _jarvisCallbacks.push(callback);
  if (!_jarvisSource) {
    _jarvisSource = new EventSource('/api/stream');
    _jarvisSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        _jarvisCallbacks.forEach(cb => cb(data));
      } catch (err) {
        console.warn('Jarvis stream: failed to parse SSE data', err);
      }
    };
    _jarvisSource.onerror = () => {
      console.warn('Jarvis SSE connection error, reconnecting...');
    };
  }
}

window.onJarvisStream = onJarvisStream;

// ─────────────────────────────────────────────
// jarvis-feed — Activity Feed
// ─────────────────────────────────────────────
WIDGETS['jarvis-feed'] = {
  name: 'Activity Feed',
  icon: '📡',
  category: 'large',
  description: 'Live feed of Jarvis tool calls, trades, errors, and messages via SSE stream.',
  defaultWidth: 420,
  defaultHeight: 400,
  hasApiKey: false,
  properties: {
    title: 'Activity Feed',
    refreshInterval: 0,
  },
  preview: `<div style="padding:8px;font-size:11px;">
    <div style="display:flex;gap:4px;margin-bottom:4px;"><span style="background:#1c3a5e;color:#58a6ff;padding:1px 5px;border-radius:3px;font-size:10px;">TOOL_CALL</span><span>jarvis_browser_navigate</span></div>
    <div style="display:flex;gap:4px;"><span style="background:#1a3a2a;color:#3fb950;padding:1px 5px;border-radius:3px;font-size:10px;">TRADE</span><span>YES @ 0.62</span></div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
      <div class="dash-card-head">
        <span class="dash-card-title">📡 ${props.title || 'Activity Feed'}</span>
        <span id="${props.id}-count" style="margin-left:auto;background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:10px;padding:1px 7px;font-size:10px;">0</span>
      </div>
      <div id="${props.id}-list" style="flex:1;overflow-y:auto;font-size:11px;">
        <div style="padding:20px;text-align:center;color:#8b949e;">Connecting...</div>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      const listEl = document.getElementById('${props.id}-list');
      const countEl = document.getElementById('${props.id}-count');
      const FEED_MAX = 20;
      let events_${props.id.replace(/-/g, '_')} = [];

      const TYPE_STYLES = {
        tool_call: 'background:#1c3a5e;color:#58a6ff',
        trade:     'background:#1a3a2a;color:#3fb950',
        error:     'background:#3d1515;color:#f85149',
        heartbeat: 'background:#21262d;color:#6e7681',
        message:   'background:#2d1f4e;color:#bc8cff',
        subagent:  'background:#2a2518;color:#d29922',
      };

      function fmtTs(iso) {
        if (!iso) return '';
        return new Date(iso).toLocaleTimeString('en-CA', { hour12: false });
      }

      function renderFeed() {
        if (!listEl) return;
        if (events_${props.id.replace(/-/g, '_')}.length === 0) {
          listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">No events yet</div>';
          return;
        }
        const html = events_${props.id.replace(/-/g, '_')}.map(ev => {
          const style = TYPE_STYLES[ev.type] || 'background:#21262d;color:#8b949e';
          const label = window._esc ? window._esc(ev.type) : ev.type;
          const summary = window._esc ? window._esc(ev.tool ? ev.tool + ': ' + ev.summary : ev.summary) : (ev.summary || '');
          const resultPreview = (ev.detail && ev.detail.result) ? window._esc(String(ev.detail.result).slice(0, 100)) : null;
          return '<div style="border-bottom:1px solid #21262d;padding:6px 10px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">'
            + '<span style="font-family:monospace;font-size:10px;color:#8b949e;white-space:nowrap;">' + fmtTs(ev.timestamp) + '</span>'
            + '<span style="' + style + ';font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;text-transform:uppercase;white-space:nowrap;">' + label + '</span>'
            + '<span style="color:#e6edf3;word-break:break-word;">' + summary + '</span>'
            + (resultPreview ? '<div style="width:100%;margin-top:2px;padding-left:2px;color:#8b949e;font-family:monospace;font-size:9px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">↳ ' + resultPreview + '</div>' : '')
            + '</div>';
        }).join('');
        listEl.innerHTML = html;
        if (countEl) countEl.textContent = String(events_${props.id.replace(/-/g, '_')}.length);
      }

      // Load initial events
      fetch('/api/events').then(r => r.json()).then(d => {
        if (d.ok && Array.isArray(d.data)) {
          events_${props.id.replace(/-/g, '_')} = d.data.slice(0, FEED_MAX);
          renderFeed();
        }
      }).catch(() => {});

      // Subscribe to live stream
      window.onJarvisStream && window.onJarvisStream(function(payload) {
        if (payload.kind !== 'event') return;
        const ev = {
          timestamp: payload.timestamp,
          type:      payload.type,
          tool:      payload.tool,
          summary:   payload.summary,
          status:    payload.status,
          detail:    payload.detail || null,
        };
        events_${props.id.replace(/-/g, '_')}.unshift(ev);
        if (events_${props.id.replace(/-/g, '_')}.length > FEED_MAX) {
          events_${props.id.replace(/-/g, '_')}.pop();
        }
        renderFeed();
      });
    })();
  `,
};

// ─────────────────────────────────────────────
// jarvis-agents — Sub-Agents
// ─────────────────────────────────────────────
WIDGETS['jarvis-agents'] = {
  name: 'Sub-Agents',
  icon: '🤖',
  category: 'large',
  description: 'Shows active and recent Jarvis sub-agents with status, task, and runtime.',
  defaultWidth: 380,
  defaultHeight: 280,
  hasApiKey: false,
  properties: {
    title: 'Sub-Agents',
    refreshInterval: 5,
  },
  preview: `<div style="padding:8px;font-size:11px;">
    <div style="background:#161b22;border:1px solid #238636;border-radius:6px;padding:6px;margin-bottom:4px;">
      <span style="background:#1a3a2a;color:#3fb950;padding:1px 5px;border-radius:3px;font-size:10px;">RUNNING</span>
      <span style="margin-left:6px;font-weight:600;">researcher</span>
    </div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
      <div class="dash-card-head">
        <span class="dash-card-title">🤖 ${props.title || 'Sub-Agents'}</span>
        <span id="${props.id}-count" style="margin-left:auto;background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:10px;padding:1px 7px;font-size:10px;">0</span>
      </div>
      <div id="${props.id}-grid" style="flex:1;overflow-y:auto;padding:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px;align-content:start;font-size:11px;">
        <div style="padding:16px;text-align:center;color:#8b949e;grid-column:1/-1;">Loading...</div>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      const gridEl = document.getElementById('${props.id}-grid');
      const countEl = document.getElementById('${props.id}-count');
      const agentOutput_${props.id.replace(/-/g, '_')} = {};

      const STATUS_STYLES = {
        running:   { border: '#238636', badge: 'background:#1a3a2a;color:#3fb950', dot: '#3fb950' },
        completed: { border: '#30363d', badge: 'background:#21262d;color:#6e7681', dot: '#6e7681' },
        failed:    { border: '#6e2020', badge: 'background:#3d1515;color:#f85149', dot: '#f85149' },
        cancelled: { border: '#3d3a1a', badge: 'background:#2a2518;color:#d29922', dot: '#d29922' },
      };

      function fmtTs(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleTimeString('en-CA', { hour12: false });
      }

      function fmtDur(startIso, endIso) {
        if (!startIso) return '';
        const start = new Date(startIso).getTime();
        const end = endIso ? new Date(endIso).getTime() : Date.now();
        const s = Math.round((end - start) / 1000);
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
        return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
      }

      function renderAgents(agents) {
        if (!gridEl) return;
        if (!agents || agents.length === 0) {
          gridEl.innerHTML = '<div style="padding:16px;text-align:center;color:#8b949e;grid-column:1/-1;">No sub-agents yet</div>';
          if (countEl) countEl.textContent = '0';
          return;
        }
        agents.sort((a, b) => {
          if (a.status === 'running' && b.status !== 'running') return -1;
          if (b.status === 'running' && a.status !== 'running') return 1;
          return new Date(b.started_at || b.startedAt || 0).getTime() - new Date(a.started_at || a.startedAt || 0).getTime();
        });
        const esc = window._esc || (s => String(s || ''));
        gridEl.innerHTML = agents.map(ag => {
          const st = STATUS_STYLES[ag.status] || STATUS_STYLES.completed;
          const task = esc(ag.task || 'No task description');
          const name = esc(ag.name || ag.id);
          const status = esc(ag.status || 'unknown');
          const started = ag.started_at || ag.startedAt;
          const completed = ag.completed_at || ag.completedAt;
          const dur = fmtDur(started, completed);
          return '<div style="background:#161b22;border:1px solid ' + st.border + ';border-radius:6px;padding:8px;">'
            + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">'
            + '<div style="width:7px;height:7px;border-radius:50%;background:' + st.dot + ';flex-shrink:0;"></div>'
            + '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + name + '</div>'
            + '<span style="' + st.badge + ';font-size:9px;font-weight:600;text-transform:uppercase;padding:1px 5px;border-radius:3px;">' + status + '</span>'
            + '</div>'
            + '<div style="color:#8b949e;font-size:10px;line-height:1.4;margin-bottom:5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">' + task + '</div>'
            + '<div style="font-family:monospace;font-size:10px;color:#6e7681;display:flex;gap:8px;">'
            + '<span>Started ' + fmtTs(started) + '</span>'
            + (dur ? '<span>' + dur + '</span>' : '')
            + '</div>'
            + (ag.status === 'running' ? '<div id="output-' + ag.id + '" style="margin-top:5px;background:#0d1117;border:1px solid #21262d;border-radius:3px;padding:4px 6px;max-height:80px;overflow-y:auto;font-family:monospace;font-size:9px;color:#58a6ff;white-space:pre-wrap;word-break:break-all;">' + esc((agentOutput_${props.id.replace(/-/g, '_')}[ag.id] || []).join('').slice(-500)) + '</div>' : '')
            + '</div>';
        }).join('');
        if (countEl) countEl.textContent = String(agents.length);
      }

      function refresh_${props.id.replace(/-/g, '_')}() {
        fetch('/api/subagents').then(r => r.json()).then(d => {
          if (d.ok && Array.isArray(d.data)) renderAgents(d.data);
        }).catch(() => {});
      }

      refresh_${props.id.replace(/-/g, '_')}();
      const _interval_${props.id.replace(/-/g, '_')} = setInterval(refresh_${props.id.replace(/-/g, '_')}, ${(props.refreshInterval || 5) * 1000});

      // Also update when SSE fires subagent events
      window.onJarvisStream && window.onJarvisStream(function(payload) {
        if (payload.kind === 'subagent') {
          refresh_${props.id.replace(/-/g, '_')}();
        }
        if (payload.kind === 'subagent_output') {
          const id = payload.id;
          if (!agentOutput_${props.id.replace(/-/g, '_')}[id]) {
            agentOutput_${props.id.replace(/-/g, '_')}[id] = [];
          }
          agentOutput_${props.id.replace(/-/g, '_')}[id].push(payload.chunk || '');
          // Update the output div if it exists (without full re-render)
          const outEl = document.getElementById('output-' + id);
          if (outEl) {
            const fullText = agentOutput_${props.id.replace(/-/g, '_')}[id].join('');
            outEl.textContent = fullText.slice(-500);
            outEl.scrollTop = outEl.scrollHeight;
          }
        }
      });
    })();
  `,
};

// ─────────────────────────────────────────────
// jarvis-neural — Neural Map
// ─────────────────────────────────────────────
WIDGETS['jarvis-neural'] = {
  name: 'Neural Map',
  icon: '🧠',
  category: 'large',
  description: 'Canvas visualization of Jarvis core connected to tool groups. Highlights active tools via SSE.',
  defaultWidth: 480,
  defaultHeight: 360,
  hasApiKey: false,
  properties: {
    title: 'Neural Map',
    refreshInterval: 0,
  },
  preview: `<div style="padding:8px;text-align:center;color:#8b949e;font-size:11px;">
    <div style="font-size:20px;">🧠</div>
    <div>Real-time tool activity map</div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
      <div class="dash-card-head">
        <span class="dash-card-title">🧠 ${props.title || 'Neural Map'}</span>
        <span id="${props.id}-badge" style="margin-left:auto;background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:10px;padding:1px 7px;font-size:10px;">idle</span>
      </div>
      <div style="flex:1;position:relative;min-height:0;">
        <canvas id="${props.id}-canvas" style="display:block;width:100%;height:100%;"></canvas>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      const canvas = document.getElementById('${props.id}-canvas');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const badge = document.getElementById('${props.id}-badge');

      const TOOL_GROUPS = [
        { id: 'browser',    label: 'Browser',    color: '#bc8cff', prefixes: ['jarvis_browser_'] },
        { id: 'polymarket', label: 'Polymarket', color: '#3fb950', prefixes: ['jarvis_polymarket_'] },
        { id: 'github',     label: 'GitHub',     color: '#8b949e', prefixes: ['jarvis_github_'] },
        { id: 'imessage',   label: 'iMessage',   color: '#58a6ff', prefixes: ['jarvis_imessage_'] },
        { id: 'calendar',   label: 'Calendar',   color: '#d29922', prefixes: ['jarvis_calendar_'] },
        { id: 'crypto',     label: 'Crypto',     color: '#26d4c8', prefixes: ['jarvis_crypto_'] },
        { id: 'news',       label: 'News',       color: '#ff7b72', prefixes: ['jarvis_news_'] },
        { id: 'system',     label: 'System',     color: '#f85149', prefixes: ['jarvis_sys_', 'jarvis_mac_'] },
        { id: 'memory',     label: 'Memory',     color: '#e3b341', prefixes: ['jarvis_memory_'] },
        { id: 'search',     label: 'Search',     color: '#79c0ff', prefixes: ['jarvis_brave_', 'jarvis_perplexity_', 'jarvis_firecrawl_', 'jarvis_weather', 'jarvis_get_price'] },
      ];

      const activeGroups_${props.id.replace(/-/g, '_')} = {};
      const ACTIVE_DURATION = 3000;

      function toolToGroup_${props.id.replace(/-/g, '_')}(toolName) {
        if (!toolName) return null;
        for (const grp of TOOL_GROUPS) {
          for (const prefix of grp.prefixes) {
            if (toolName.startsWith(prefix)) return grp.id;
          }
        }
        return null;
      }

      function resizeCanvas_${props.id.replace(/-/g, '_')}() {
        const wrap = canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = wrap.clientWidth * dpr;
        canvas.height = wrap.clientHeight * dpr;
        ctx.scale(dpr, dpr);
      }

      function drawNode_${props.id.replace(/-/g, '_')}(x, y, r, color, glowStr, label, below) {
        if (glowStr > 0) {
          const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.5);
          grad.addColorStop(0, color + Math.floor(glowStr * 255).toString(16).padStart(2, '0'));
          grad.addColorStop(1, color + '00');
          ctx.beginPath();
          ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#0d1117';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = glowStr > 0 ? 2 : 1.5;
        ctx.globalAlpha = 0.5 + glowStr * 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (label) {
          ctx.font = 'bold 9px -apple-system,sans-serif';
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.textBaseline = below ? 'top' : 'middle';
          ctx.fillText(label, x, below ? y + r + 4 : y);
        }
      }

      function drawEdge_${props.id.replace(/-/g, '_')}(cx, cy, nx, ny, color, alpha, animated, t) {
        ctx.save();
        ctx.globalAlpha = alpha;
        if (animated) {
          ctx.setLineDash([8, 6]);
          ctx.lineDashOffset = -(t / 50) % 14;
          ctx.shadowColor = color;
          ctx.shadowBlur = 8;
        } else {
          ctx.setLineDash([]);
          ctx.shadowBlur = 0;
        }
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(nx, ny);
        ctx.strokeStyle = color;
        ctx.lineWidth = animated ? 1.5 : 1;
        ctx.stroke();
        ctx.restore();
      }

      let raf_${props.id.replace(/-/g, '_')} = null;

      function drawFrame_${props.id.replace(/-/g, '_')}(t) {
        const w = canvas.width / (window.devicePixelRatio || 1);
        const h = canvas.height / (window.devicePixelRatio || 1);
        ctx.clearRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const orbitR = Math.min(w, h) * 0.36;
        const nodeR = 18;
        const coreR = 24;
        const now = Date.now();

        const groupPos = TOOL_GROUPS.map((grp, i) => {
          const angle = (i / TOOL_GROUPS.length) * Math.PI * 2 - Math.PI / 2;
          return { id: grp.id, x: cx + Math.cos(angle) * orbitR, y: cy + Math.sin(angle) * orbitR, color: grp.color, label: grp.label, angle };
        });

        // Draw orbit ring
        ctx.save();
        ctx.globalAlpha = 0.06;
        ctx.beginPath();
        ctx.arc(cx, cy, orbitR, 0, Math.PI * 2);
        ctx.strokeStyle = '#8b949e';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.restore();

        for (const pos of groupPos) {
          const act = activeGroups_${props.id.replace(/-/g, '_')}[pos.id];
          const elapsed = act ? now - act.activatedAt : Infinity;
          const isActive = elapsed < ACTIVE_DURATION;
          const alpha = isActive ? 0.9 * (1 - elapsed / ACTIVE_DURATION) + 0.15 : 0.12;
          drawEdge_${props.id.replace(/-/g, '_')}(cx, cy, pos.x, pos.y, pos.color, alpha, isActive, t);
        }

        for (const pos of groupPos) {
          const act = activeGroups_${props.id.replace(/-/g, '_')}[pos.id];
          const elapsed = act ? now - act.activatedAt : Infinity;
          const glow = elapsed < ACTIVE_DURATION ? Math.max(0, 1 - elapsed / ACTIVE_DURATION) : 0;
          drawNode_${props.id.replace(/-/g, '_')}(pos.x, pos.y, nodeR, pos.color, glow, pos.label, pos.y >= cy);
        }

        const coreGlow = 0.3 + 0.15 * Math.sin(t / 800);
        drawNode_${props.id.replace(/-/g, '_')}(cx, cy, coreR, '#58a6ff', coreGlow, 'JARVIS', false);

        // Clean expired activations
        for (const [id, act] of Object.entries(activeGroups_${props.id.replace(/-/g, '_')})) {
          if (now - act.activatedAt > ACTIVE_DURATION) {
            delete activeGroups_${props.id.replace(/-/g, '_')}[id];
            if (badge) badge.textContent = 'idle';
          }
        }

        raf_${props.id.replace(/-/g, '_')} = requestAnimationFrame(drawFrame_${props.id.replace(/-/g, '_')});
      }

      resizeCanvas_${props.id.replace(/-/g, '_')}();
      raf_${props.id.replace(/-/g, '_')} = requestAnimationFrame(drawFrame_${props.id.replace(/-/g, '_')});

      const _resizeObs_${props.id.replace(/-/g, '_')} = new ResizeObserver(() => { resizeCanvas_${props.id.replace(/-/g, '_')}(); });
      _resizeObs_${props.id.replace(/-/g, '_')}.observe(canvas.parentElement);

      window.onJarvisStream && window.onJarvisStream(function(payload) {
        if (payload.kind !== 'event' || !payload.tool) return;
        const gid = toolToGroup_${props.id.replace(/-/g, '_')}(payload.tool);
        if (gid) {
          activeGroups_${props.id.replace(/-/g, '_')}[gid] = { activatedAt: Date.now() };
          const grp = TOOL_GROUPS.find(g => g.id === gid);
          if (badge && grp) badge.textContent = grp.label;
        }
      });
    })();
  `,
};

// ─────────────────────────────────────────────
// jarvis-stats — Jarvis Stats
// ─────────────────────────────────────────────
WIDGETS['jarvis-stats'] = {
  name: 'Jarvis Stats',
  icon: '📊',
  category: 'small',
  description: 'Shows events today, events per hour, active agents, and last heartbeat from Jarvis.',
  defaultWidth: 280,
  defaultHeight: 160,
  hasApiKey: false,
  properties: {
    title: 'Jarvis Stats',
    refreshInterval: 10,
  },
  preview: `<div style="padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;">
    <div style="background:#161b22;border:1px solid #30363d;border-radius:4px;padding:6px;text-align:center;">
      <div style="font-size:18px;font-weight:700;color:#58a6ff;">42</div>
      <div style="color:#8b949e;font-size:10px;">Events Today</div>
    </div>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:4px;padding:6px;text-align:center;">
      <div style="font-size:18px;font-weight:700;color:#3fb950;">2</div>
      <div style="color:#8b949e;font-size:10px;">Active Agents</div>
    </div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;">
      <div class="dash-card-head">
        <span class="dash-card-title">📊 ${props.title || 'Jarvis Stats'}</span>
      </div>
      <div class="dash-card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px;">
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;text-align:center;">
          <div id="${props.id}-today" class="kpi-value blue">—</div>
          <div class="kpi-label">Events Today</div>
        </div>
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;text-align:center;">
          <div id="${props.id}-hour" class="kpi-value" style="color:#bc8cff;">—</div>
          <div class="kpi-label">Events / Hour</div>
        </div>
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;text-align:center;">
          <div id="${props.id}-agents" class="kpi-value" style="color:#3fb950;">—</div>
          <div class="kpi-label">Active Agents</div>
        </div>
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;text-align:center;">
          <div id="${props.id}-hb" class="kpi-value" style="font-size:13px;color:#8b949e;">—</div>
          <div class="kpi-label">Last Heartbeat</div>
        </div>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      function fmtTs(iso) {
        if (!iso) return 'Never';
        return new Date(iso).toLocaleTimeString('en-CA', { hour12: false });
      }

      function updateStats_${props.id.replace(/-/g, '_')}(d) {
        const todayEl  = document.getElementById('${props.id}-today');
        const hourEl   = document.getElementById('${props.id}-hour');
        const agentsEl = document.getElementById('${props.id}-agents');
        const hbEl     = document.getElementById('${props.id}-hb');
        if (todayEl)  todayEl.textContent  = String(d.eventsToday ?? '—');
        if (hourEl)   hourEl.textContent   = String(d.eventsLastHour ?? '—');
        if (agentsEl) agentsEl.textContent = String(d.activeAgents ?? '—');
        if (hbEl)     hbEl.textContent     = fmtTs(d.lastHeartbeat);
      }

      function refresh_${props.id.replace(/-/g, '_')}() {
        fetch('/api/jarvis/stats').then(r => r.json()).then(d => {
          if (d.ok) updateStats_${props.id.replace(/-/g, '_')}(d.data);
        }).catch(() => {});
      }

      refresh_${props.id.replace(/-/g, '_')}();
      setInterval(refresh_${props.id.replace(/-/g, '_')}, ${(props.refreshInterval || 10) * 1000});

      // Update heartbeat timestamp live
      window.onJarvisStream && window.onJarvisStream(function(payload) {
        if (payload.kind === 'event' && payload.type === 'heartbeat') {
          const hbEl = document.getElementById('${props.id}-hb');
          if (hbEl) hbEl.textContent = new Date(payload.timestamp).toLocaleTimeString('en-CA', { hour12: false });
        }
      });
    })();
  `,
};

// ─────────────────────────────────────────────
// jarvis-polymarket — Polymarket Trades
// ─────────────────────────────────────────────
WIDGETS['jarvis-polymarket'] = {
  name: 'Polymarket',
  icon: '📈',
  category: 'large',
  description: 'Shows recent Polymarket trades executed by Jarvis.',
  defaultWidth: 360,
  defaultHeight: 280,
  hasApiKey: false,
  properties: {
    title: 'Polymarket Trades',
    refreshInterval: 30,
  },
  preview: `<div style="padding:8px;font-size:11px;">
    <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #21262d;">
      <span style="color:#3fb950;font-weight:600;">YES</span>
      <span>$50 @ 0.62</span>
      <span style="color:#3fb950;">+8.2%</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:5px 0;">
      <span style="color:#f85149;font-weight:600;">NO</span>
      <span>$25 @ 0.35</span>
      <span style="color:#f85149;">−3.1%</span>
    </div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
      <div class="dash-card-head">
        <span class="dash-card-title">📈 ${props.title || 'Polymarket Trades'}</span>
      </div>
      <div id="${props.id}-list" style="flex:1;overflow-y:auto;font-size:11px;">
        <div style="padding:20px;text-align:center;color:#8b949e;">Loading...</div>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      const listEl = document.getElementById('${props.id}-list');

      function renderTrades_${props.id.replace(/-/g, '_')}(trades) {
        if (!listEl) return;
        if (!trades || trades.length === 0) {
          listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">No trades yet</div>';
          return;
        }
        const esc = window._esc || (s => String(s || ''));
        listEl.innerHTML = trades.map(ev => {
          let detail = {};
          try { detail = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : (ev.detail || {}); } catch (e) {}
          const outcome = esc(detail.outcome || ev.summary || '—');
          const amount  = detail.amount  != null ? '$' + Number(detail.amount).toFixed(0)  : '—';
          const price   = detail.price   != null ? '@ ' + Number(detail.price).toFixed(3)  : '';
          const edge    = detail.edge    != null ? (Number(detail.edge) >= 0 ? '+' : '') + Number(detail.edge).toFixed(1) + '%' : '';
          const edgeColor = detail.edge != null && Number(detail.edge) >= 0 ? '#3fb950' : '#f85149';
          const ts = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString('en-CA', { hour12: false }) : '';
          return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #21262d;">'
            + '<span style="font-weight:700;color:#3fb950;min-width:30px;">' + outcome + '</span>'
            + '<span style="flex:1;">' + amount + ' ' + price + '</span>'
            + (edge ? '<span style="color:' + edgeColor + ';font-weight:600;">' + edge + '</span>' : '')
            + '<span style="font-family:monospace;font-size:10px;color:#6e7681;">' + ts + '</span>'
            + '</div>';
        }).join('');
      }

      function refresh_${props.id.replace(/-/g, '_')}() {
        fetch('/api/events').then(r => r.json()).then(d => {
          if (d.ok && Array.isArray(d.data)) {
            const trades = d.data.filter(ev => ev.type === 'trade').slice(0, 20);
            renderTrades_${props.id.replace(/-/g, '_')}(trades);
          }
        }).catch(() => {});
      }

      refresh_${props.id.replace(/-/g, '_')}();
      setInterval(refresh_${props.id.replace(/-/g, '_')}, ${(props.refreshInterval || 30) * 1000});

      // Also update on live trade events
      window.onJarvisStream && window.onJarvisStream(function(payload) {
        if (payload.kind === 'event' && payload.type === 'trade') {
          refresh_${props.id.replace(/-/g, '_')}();
        }
      });
    })();
  `,
};

// ─────────────────────────────────────────────
// jarvis-portfolio — Polymarket Portfolio
// ─────────────────────────────────────────────
WIDGETS['jarvis-portfolio'] = {
  name: 'Portfolio',
  icon: '💰',
  category: 'large',
  description: 'Live Polymarket portfolio positions with P&L tracking.',
  defaultWidth: 420,
  defaultHeight: 300,
  hasApiKey: false,
  properties: {
    title: 'Portfolio',
    refreshInterval: 30,
  },
  preview: `<div style="padding:8px;font-size:11px;">
    <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d;">
      <span style="color:#e6edf3;">Will BTC hit 100k?</span>
      <span style="color:#3fb950;">+$12.40</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:4px 0;">
      <span style="color:#e6edf3;">Fed rate cut 2025?</span>
      <span style="color:#f85149;">−$3.20</span>
    </div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
      <div class="dash-card-head">
        <span class="dash-card-title">💰 ${props.title || 'Portfolio'}</span>
        <span id="${props.id}-summary" style="margin-left:auto;font-size:10px;color:#8b949e;"></span>
      </div>
      <div style="overflow-x:auto;flex:1;overflow-y:auto;">
        <table id="${props.id}-table" style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="color:#6e7681;border-bottom:1px solid #21262d;position:sticky;top:0;background:#0d1117;">
              <th style="text-align:left;padding:5px 8px;font-weight:500;">Market</th>
              <th style="text-align:left;padding:5px 4px;font-weight:500;">Side</th>
              <th style="text-align:right;padding:5px 4px;font-weight:500;">Size</th>
              <th style="text-align:right;padding:5px 4px;font-weight:500;">Avg</th>
              <th style="text-align:right;padding:5px 4px;font-weight:500;">Value</th>
              <th style="text-align:right;padding:5px 8px;font-weight:500;">P&amp;L</th>
            </tr>
          </thead>
          <tbody id="${props.id}-body">
            <tr><td colspan="6" style="padding:20px;text-align:center;color:#8b949e;">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      const bodyEl   = document.getElementById('${props.id}-body');
      const summaryEl = document.getElementById('${props.id}-summary');

      function renderPortfolio_${props.id.replace(/-/g, '_')}(positions) {
        if (!bodyEl) return;
        if (!positions || positions.length === 0) {
          bodyEl.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:#8b949e;">No open positions</td></tr>';
          if (summaryEl) summaryEl.textContent = '';
          return;
        }
        let totalValue = 0, totalPnl = 0;
        const esc = window._esc || (s => String(s || ''));
        bodyEl.innerHTML = positions.map(p => {
          const pnl = (p.realizedPnl || 0) + (p.unrealizedPnl || 0);
          totalValue += p.currentValue || 0;
          totalPnl += pnl;
          const pnlColor = pnl >= 0 ? '#3fb950' : '#f85149';
          const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
          const title = esc(p.title || p.asset || '—').substring(0, 32) + (((p.title || p.asset || '').length > 32) ? '…' : '');
          return '<tr style="border-bottom:1px solid #21262d;">'
            + '<td style="padding:6px 8px;color:#e6edf3;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(p.title) + '">' + title + '</td>'
            + '<td style="padding:6px 4px;color:#8b949e;">' + esc(p.outcome) + '</td>'
            + '<td style="padding:6px 4px;text-align:right;color:#c9d1d9;">' + Number(p.size).toFixed(2) + '</td>'
            + '<td style="padding:6px 4px;text-align:right;color:#c9d1d9;">' + Number(p.avgPrice).toFixed(3) + '</td>'
            + '<td style="padding:6px 4px;text-align:right;color:#c9d1d9;">$' + Number(p.currentValue).toFixed(2) + '</td>'
            + '<td style="padding:6px 8px;text-align:right;color:' + pnlColor + ';font-weight:600;">' + pnlStr + '</td>'
            + '</tr>';
        }).join('');
        if (summaryEl) {
          const totalPnlColor = totalPnl >= 0 ? '#3fb950' : '#f85149';
          summaryEl.innerHTML = 'Value: $' + totalValue.toFixed(2) + ' &nbsp; P&amp;L: <span style="color:' + totalPnlColor + ';font-weight:700;">' + (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2) + '</span>';
        }
      }

      function refresh_${props.id.replace(/-/g, '_')}() {
        fetch('/api/polymarket/portfolio').then(r => r.json()).then(d => {
          if (d.ok && Array.isArray(d.data)) {
            renderPortfolio_${props.id.replace(/-/g, '_')}(d.data);
          } else {
            if (bodyEl) bodyEl.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:#f85149;">' + (d.error || 'Error loading portfolio') + '</td></tr>';
          }
        }).catch(() => {
          if (bodyEl) bodyEl.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:#8b949e;">Failed to load</td></tr>';
        });
      }

      refresh_${props.id.replace(/-/g, '_')}();
      setInterval(refresh_${props.id.replace(/-/g, '_')}, ${(props.refreshInterval || 30) * 1000});

      // Refresh on live trade events
      window.onJarvisStream && window.onJarvisStream(function(payload) {
        if (payload.kind === 'event' && payload.type === 'trade') {
          refresh_${props.id.replace(/-/g, '_')}();
        }
      });
    })();
  `,
};

// ─────────────────────────────────────────────
// jarvis-imessage — iMessage Feed
// ─────────────────────────────────────────────
WIDGETS['jarvis-imessage'] = {
  name: 'iMessage Feed',
  icon: '💬',
  category: 'large',
  description: 'Recent iMessages from macOS Messages app.',
  defaultWidth: 360,
  defaultHeight: 300,
  hasApiKey: false,
  properties: {
    title: 'iMessage Feed',
    refreshInterval: 60,
  },
  preview: `<div style="padding:8px;font-size:11px;">
    <div style="text-align:right;margin-bottom:4px;"><span style="background:#0a84ff;color:#fff;border-radius:8px;padding:3px 8px;">Hey, sounds good!</span></div>
    <div style="text-align:left;"><span style="background:#2d2d2d;color:#e6edf3;border-radius:8px;padding:3px 8px;">On my way now</span></div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
      <div class="dash-card-head">
        <span class="dash-card-title">💬 ${props.title || 'iMessage Feed'}</span>
      </div>
      <div id="${props.id}-list" style="flex:1;overflow-y:auto;font-size:11px;padding:4px 0;">
        <div style="padding:20px;text-align:center;color:#8b949e;">Loading...</div>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      const listEl = document.getElementById('${props.id}-list');

      function renderMessages_${props.id.replace(/-/g, '_')}(messages) {
        if (!listEl) return;
        if (!messages || messages.length === 0) {
          listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">No messages</div>';
          return;
        }
        const esc = window._esc || (s => String(s || ''));
        listEl.innerHTML = messages.map(msg => {
          const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('en-CA', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
          const contact = esc(msg.displayName || msg.contact || 'Unknown');
          const text = esc((msg.text || '').substring(0, 80)) + ((msg.text || '').length > 80 ? '…' : '');
          if (msg.isFromMe) {
            return '<div style="padding:4px 10px;display:flex;flex-direction:column;align-items:flex-end;">'
              + '<div style="font-size:9px;color:#6e7681;margin-bottom:2px;">' + ts + '</div>'
              + '<div style="background:#0a84ff;color:#fff;border-radius:12px 12px 2px 12px;padding:5px 10px;max-width:80%;word-break:break-word;">' + text + '</div>'
              + '</div>';
          } else {
            return '<div style="padding:4px 10px;display:flex;flex-direction:column;align-items:flex-start;">'
              + '<div style="font-size:9px;color:#6e7681;margin-bottom:2px;">' + contact + ' · ' + ts + '</div>'
              + '<div style="background:#2d2d2d;color:#e6edf3;border-radius:12px 12px 12px 2px;padding:5px 10px;max-width:80%;word-break:break-word;">' + text + '</div>'
              + '</div>';
          }
        }).join('');
      }

      function refresh_${props.id.replace(/-/g, '_')}() {
        fetch('/api/imessage/recent').then(r => r.json()).then(d => {
          if (d.ok && Array.isArray(d.data)) {
            renderMessages_${props.id.replace(/-/g, '_')}(d.data);
          } else {
            if (listEl) listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#f85149;">' + ((window._esc ? window._esc(d.error) : String(d.error || 'Error')) ) + '</div>';
          }
        }).catch(() => {
          if (listEl) listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">Failed to load messages</div>';
        });
      }

      refresh_${props.id.replace(/-/g, '_')}();
      setInterval(refresh_${props.id.replace(/-/g, '_')}, ${(props.refreshInterval || 60) * 1000});
    })();
  `,
};

// ─────────────────────────────────────────────
// jarvis-live — Live Agent Response
// ─────────────────────────────────────────────
WIDGETS['jarvis-live'] = {
  name: 'Live Agent',
  icon: '⚡',
  category: 'large',
  description: 'Live streaming view of the agent response — see tokens arrive in real-time, tool calls as they happen, and the full response as it builds.',
  defaultWidth: 500,
  defaultHeight: 400,
  hasApiKey: false,
  properties: {
    title: 'Live Agent',
    refreshInterval: 0,
  },
  preview: `<div style="padding:8px;font-size:11px;">
    <div style="color:#3fb950;font-size:10px;margin-bottom:4px;">● STREAMING</div>
    <div style="color:#e6edf3;font-family:monospace;">Hello! I'm analyzing the market data...</div>
  </div>`,
  generateHtml: (props) => `
    <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
      <div class="dash-card-head">
        <span class="dash-card-title">⚡ ${props.title || 'Live Agent'}</span>
        <span id="${props.id}-status" style="margin-left:auto;font-size:10px;color:#8b949e;">IDLE</span>
      </div>
      <div id="${props.id}-tools" style="padding:4px 10px;font-size:10px;color:#8b949e;border-bottom:1px solid #21262d;display:none;"></div>
      <div id="${props.id}-body" style="flex:1;overflow-y:auto;padding:10px;font-size:12px;font-family:'SF Mono',Monaco,monospace;line-height:1.5;color:#e6edf3;white-space:pre-wrap;word-break:break-word;">
        <span style="color:#8b949e;">Waiting for agent activity...</span>
      </div>
    </div>`,
  generateJs: (props) => `
    (function() {
      const bodyEl = document.getElementById('${props.id}-body');
      const statusEl = document.getElementById('${props.id}-status');
      const toolsEl = document.getElementById('${props.id}-tools');
      let buffer = '';
      let activeTools = [];
      let lastActivity = 0;

      function updateStatus(text, color) {
        if (statusEl) {
          statusEl.textContent = text;
          statusEl.style.color = color;
        }
      }

      function renderTools() {
        if (!toolsEl) return;
        if (activeTools.length === 0) {
          toolsEl.style.display = 'none';
          return;
        }
        toolsEl.style.display = 'block';
        toolsEl.innerHTML = activeTools.map(t =>
          '<span style="background:#1c3a5e;color:#58a6ff;padding:1px 5px;border-radius:3px;margin-right:4px;">' + (window._esc ? window._esc(t) : t) + '</span>'
        ).join('');
      }

      window.onJarvisStream && window.onJarvisStream(function(payload) {
        if (payload.kind === 'agent_token') {
          if (lastActivity === 0 || Date.now() - lastActivity > 30000) {
            buffer = '';
          }
          lastActivity = Date.now();
          buffer += payload.text;
          if (bodyEl) bodyEl.textContent = buffer;
          if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
          updateStatus('● STREAMING', '#3fb950');
        }

        if (payload.kind === 'agent_status') {
          lastActivity = Date.now();
          if (payload.status === 'tool_call' && payload.toolName) {
            const label = payload.toolName.replace(/_/g, ' ');
            activeTools.push(label);
            renderTools();
            updateStatus('● TOOL: ' + label, '#58a6ff');
          }
          if (payload.status === 'tool_done') {
            const label = (payload.toolName || '').replace(/_/g, ' ');
            activeTools = activeTools.filter(t => t !== label);
            renderTools();
            if (activeTools.length === 0) {
              updateStatus('● STREAMING', '#3fb950');
            }
          }
        }

        if (payload.kind === 'agent_complete') {
          activeTools = [];
          renderTools();
          updateStatus('COMPLETE', '#8b949e');
          if (payload.text && bodyEl) {
            bodyEl.textContent = payload.text;
            bodyEl.scrollTop = bodyEl.scrollHeight;
          }
          buffer = '';
        }
      });
    })();
  `,
};
