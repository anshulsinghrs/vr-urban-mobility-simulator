/* hud.jsx — Research-instrument HUD overlays + Tweaks panel
 * ─────────────────────────────────────────────────────────────────────────
 * Reads from window.__sim.state on a steady tick and renders the
 * surrounding research telemetry. Most numeric panels refresh at ~10Hz
 * (calmer reading); the minimap draws every animation frame to a canvas.
 * ───────────────────────────────────────────────────────────────────────── */
const { useState, useEffect, useRef, useCallback } = React;

function useSimTick(hz = 10) {
  const [, setT] = useState(0);
  useEffect(() => {
    let alive = true;
    const interval = 1000 / hz;
    let last = 0;
    const loop = (now) => {
      if (!alive) return;
      if (now - last > interval) {
        last = now;
        setT(now);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return () => { alive = false; };
  }, [hz]);
  return window.__sim?.state || {};
}

function fmt(n, dp = 1) {
  if (n == null || !isFinite(n)) return '—';
  return n.toFixed(dp);
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const cs = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return `${mm}:${ss}.${cs}`;
}
function fmtTOD(h) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ── Top-left: Subject / session card ──────────────────────────────────────
function SubjectCard({ s }) {
  return (
    <div className="panel" style={{ left: 18, top: 18, width: 230 }}>
      <div className="ttl">
        <span><span className="rec-dot"></span>SUBJECT 024 · TRIAL 03</span>
        <span className="pill">REC</span>
      </div>
      <div className="kv">
        <span className="k">SESSION</span><span className="v">{fmtTime(s.sessionMs || 0)}</span>
        <span className="k">PROTOCOL</span><span className="v">XW-CROSS-A</span>
        <span className="k">CLOCK</span><span className="v cyan">{fmtTOD(s.timeOfDay || 0)}</span>
        <span className="k">WEATHER</span><span className="v">{(s.weather || 'clear').toUpperCase()}</span>
        <span className="k">POS</span><span className="v">x{fmt(s.subjectPos?.x, 1)}  z{fmt(s.subjectPos?.z, 1)}</span>
        <span className="k">HEAD</span><span className="v">{fmt(((-((s.subjectHeading||0))) * 180 / Math.PI + 90 + 360) % 360, 0)}°</span>
        <span className="k">SUN</span><span className="v">az{fmt(s.sun?.az, 0)}° alt{fmt(s.sun?.alt, 0)}°</span>
      </div>
    </div>
  );
}

// ── Top-right: Gaze tracker ───────────────────────────────────────────────
function GazeTracker({ s }) {
  const yaw = s.gazeYaw || 0, pitch = s.gazePitch || 0;
  // Render a small 2D field showing gaze direction relative to forward
  const size = 96, half = size / 2;
  const dotX = half + clampN(yaw / 60, -1, 1) * (half - 6);
  const dotY = half - clampN(pitch / 30, -1, 1) * (half - 6);
  const fixSec = (s.fixationMs || 0) / 1000;
  return (
    <div className="panel" style={{ right: 60, top: 18, width: 230 }}>
      <div className="ttl">
        <span>GAZE TRACKER</span>
        <span className="pill">EYE 90Hz</span>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <svg width={size} height={size} style={{ background: 'rgba(0,0,0,.35)' }}>
          {/* concentric arcs (FOV cone) */}
          <circle cx={half} cy={half} r={half - 4} stroke="rgba(108,242,255,.18)" strokeWidth="0.5" fill="none" />
          <circle cx={half} cy={half} r={half - 18} stroke="rgba(108,242,255,.18)" strokeWidth="0.5" fill="none" />
          <line x1={half} y1={4} x2={half} y2={size - 4} stroke="rgba(108,242,255,.18)" strokeWidth="0.5" />
          <line x1={4} y1={half} x2={size - 4} y2={half} stroke="rgba(108,242,255,.18)" strokeWidth="0.5" />
          {/* gaze dot */}
          <circle cx={dotX} cy={dotY} r={3} fill="var(--hud-cyan)" />
          <circle cx={dotX} cy={dotY} r={6} fill="none" stroke="var(--hud-cyan)" strokeWidth="0.5" opacity="0.5" />
          {/* corner ticks */}
          <text x={half} y={10} textAnchor="middle" fontSize="7" fill="rgba(160,185,205,.6)" fontFamily="JetBrains Mono">UP</text>
          <text x={half} y={size - 3} textAnchor="middle" fontSize="7" fill="rgba(160,185,205,.6)" fontFamily="JetBrains Mono">DN</text>
        </svg>
        <div style={{ flex: 1 }}>
          <div className="row"><span className="lbl">YAW</span><span className="val">{fmt(yaw, 1)}°</span></div>
          <div className="row"><span className="lbl">PITCH</span><span className="val">{fmt(pitch, 1)}°</span></div>
          <div className="row"><span className="lbl">FIX</span><span className="val cyan">{fmt(fixSec, 1)}s</span></div>
          <div className="row"><span className="lbl">BLINK</span><span className="val">{fmt(s.blinkRate, 0)}/min</span></div>
          <div style={{ marginTop: 6 }}>
            <span className="lbl" style={{ fontSize: 9, letterSpacing: '.15em' }}>TARGET</span>
            <div className="val" style={{ fontSize: 10, color: s.gazeTarget ? 'var(--hud-amber)' : 'var(--hud-dim)', marginTop: 2 }}>
              {s.gazeTarget ? `${s.gazeTarget.kind.toUpperCase()} · ${fmt(s.gazeTarget.distance, 1)}m` : 'AMBIENT SCAN'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ── Bottom-left: Biometrics ───────────────────────────────────────────────
function Biometrics({ s }) {
  const hr = s.heartRate || 78;
  const hrPct = clampN((hr - 60) / 80, 0, 1);
  const gsr = s.gsr || 0.4;
  const cog = s.cognLoad || 0.3;
  const speed = s.speed || 0;
  const speedPct = clampN(speed / 2, 0, 1);
  return (
    <div className="panel" style={{ left: 18, bottom: 18, width: 230 }}>
      <div className="ttl">
        <span>BIOMETRICS</span><span className="pill">PHYSIO</span>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginBottom: 8 }}>
        <div>
          <div className="big">{fmt(speed, 2)}<span className="u">m/s</span></div>
          <div className="lbl smaller" style={{ marginTop: 2 }}>WALKING SPEED</div>
        </div>
        <div style={{ flex: 1, paddingBottom: 4 }}>
          <div className="meter cyan"><i style={{ width: `${speedPct * 100}%` }} /></div>
        </div>
      </div>
      <div className="row"><span className="lbl">HEART RATE</span>
        <span className={`val ${hr > 110 ? 'red' : hr > 95 ? 'amber' : 'green'}`}>{fmt(hr, 0)} BPM</span></div>
      <div className={`meter ${hr > 110 ? 'red' : hr > 95 ? 'amber' : ''}`}><i style={{ width: `${hrPct * 100}%` }} /></div>
      <div className="row" style={{ marginTop: 4 }}><span className="lbl">GSR</span>
        <span className="val">{fmt(gsr * 10, 2)} μS</span></div>
      <div className="meter amber"><i style={{ width: `${clampN(gsr, 0, 1) * 100}%` }} /></div>
      <div className="row" style={{ marginTop: 4 }}><span className="lbl">COGN LOAD</span>
        <span className="val">{fmt(cog * 100, 0)}%</span></div>
      <div className="meter"><i style={{ width: `${clampN(cog, 0, 1) * 100}%` }} /></div>
    </div>
  );
}

// ── Bottom-right: Safety / conflict ───────────────────────────────────────
function SafetyPanel({ s }) {
  const nv = s.nearestVehicle || {};
  const ttc = nv.ttc;
  const ttcStr = (ttc != null && isFinite(ttc) && ttc < 60) ? `${fmt(ttc, 1)}s` : '∞';
  const ttcCls = (ttc < 2) ? 'red' : (ttc < 4) ? 'amber' : 'green';
  const conflict = s.conflictLevel || 0;
  const phase = s.walkPhase || 'dont';
  const phaseColor = phase === 'walk' ? 'var(--hud-green)'
    : phase === 'flash' ? 'var(--hud-amber)' : 'var(--hud-red)';
  const phaseLabel = phase === 'walk' ? 'WALK'
    : phase === 'flash' ? 'FLASHING' : 'DON\u2019T WALK';
  return (
    <div className="panel" style={{ right: 60, bottom: 18, width: 240 }}>
      <div className="ttl">
        <span>SAFETY METRICS</span><span className="pill">CONFLICT</span>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginBottom: 8 }}>
        <div>
          <div className={`big ${ttcCls}`}>{ttcStr}</div>
          <div className="lbl smaller" style={{ marginTop: 2 }}>TIME TO COLLISION</div>
        </div>
        <div style={{ flex: 1, textAlign: 'right' }}>
          <div className="big" style={{ fontSize: 16 }}>{fmt(nv.distance, 1)}<span className="u">m</span></div>
          <div className="lbl smaller">NEAREST · {(nv.kind || '—').toUpperCase()}</div>
        </div>
      </div>
      <div className="row"><span className="lbl">BEARING</span>
        <span className="val">{fmt(nv.bearing, 0)}°</span></div>
      <div className="row"><span className="lbl">CONFLICT</span>
        <span className={`val ${conflict > 0.6 ? 'red' : conflict > 0.3 ? 'amber' : 'green'}`}>
          {(conflict * 100).toFixed(0)}%</span></div>
      <div className={`meter ${conflict > 0.6 ? 'red' : conflict > 0.3 ? 'amber' : ''}`}>
        <i style={{ width: `${clampN(conflict, 0, 1) * 100}%` }} />
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="lbl">NEAR-MISS</span><span className="val">{s.nearMisses || 0}</span></div>
      <div className="row">
        <span className="lbl">SIGNAL</span>
        <span className="val" style={{ color: phaseColor }}>{phaseLabel}
          {(phase === 'walk' || phase === 'flash') && (
            <span style={{ color: 'var(--hud-dim)', marginLeft: 6, fontSize: 10 }}>
              {fmt(s.walkRemaining, 0)}s
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

// ── Center-bottom: Minimap with trajectory + agents ───────────────────────
function Minimap({ active }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return;
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let alive = true;
    const W = cv.width, H = cv.height;
    function draw() {
      if (!alive) return;
      const s = window.__sim?.state || {};
      ctx.clearRect(0, 0, W, H);
      // background panel
      ctx.fillStyle = 'rgba(8,14,22,.78)';
      ctx.fillRect(0, 0, W, H);
      // border
      ctx.strokeStyle = 'rgba(120,200,230,.28)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
      // title
      ctx.font = '600 9.5px JetBrains Mono';
      ctx.fillStyle = 'rgba(108,242,255,.85)';
      ctx.fillText('TRAJECTORY · TOP-DOWN', 10, 14);
      ctx.font = '500 8.5px JetBrains Mono';
      ctx.fillStyle = 'rgba(160,185,205,.55)';
      ctx.fillText(`${(s.vehicles||[]).length}V · ${(s.pedestrians||[]).length}P · ${(s.cyclists||[]).length}C`, W - 86, 14);
      // scale: world ±60m maps to canvas
      const SCALE = 1.6; // px per meter
      const cx = W / 2, cy = H / 2 + 8;
      function w2x(wx) { return cx + wx * SCALE; }
      function w2y(wz) { return cy + wz * SCALE; }
      // roads — draw EW + NS as dim strips
      ctx.fillStyle = 'rgba(160,185,205,.16)';
      ctx.fillRect(0, w2y(-7), W, 14 * SCALE);
      ctx.fillRect(w2x(-7), 22, 14 * SCALE, H - 22);
      // sidewalks (lighter outline)
      ctx.strokeStyle = 'rgba(160,185,205,.18)';
      ctx.strokeRect(w2x(-11), w2y(-11), 22 * SCALE, 22 * SCALE);
      // crosswalks
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.fillRect(w2x(-7), w2y(-11), 14 * SCALE, 4 * SCALE);
      ctx.fillRect(w2x(-7), w2y(7), 14 * SCALE, 4 * SCALE);
      ctx.fillRect(w2x(-11), w2y(-7), 4 * SCALE, 14 * SCALE);
      ctx.fillRect(w2x(7), w2y(-7), 4 * SCALE, 14 * SCALE);
      // trajectory
      const traj = s.trajectory || [];
      if (traj.length > 1) {
        ctx.beginPath();
        ctx.moveTo(w2x(traj[0].x), w2y(traj[0].z));
        for (let i = 1; i < traj.length; i++) {
          ctx.lineTo(w2x(traj[i].x), w2y(traj[i].z));
        }
        ctx.strokeStyle = 'rgba(108,242,255,.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // vehicles
      ctx.fillStyle = 'rgba(255,176,80,.95)';
      (s.vehicles || []).forEach((v) => {
        const x = w2x(v.x), y = w2y(v.z);
        if (x < 0 || x > W || y < 0 || y > H) return;
        ctx.fillRect(x - 2, y - 2, 4, 4);
      });
      // peds
      ctx.fillStyle = 'rgba(225,240,255,.85)';
      (s.pedestrians || []).forEach((p) => {
        const x = w2x(p.x), y = w2y(p.z);
        if (x < 0 || x > W || y < 0 || y > H) return;
        ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
      });
      // cyclists
      ctx.fillStyle = 'rgba(90,240,168,.95)';
      (s.cyclists || []).forEach((c) => {
        const x = w2x(c.x), y = w2y(c.z);
        if (x < 0 || x > W || y < 0 || y > H) return;
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
      });
      // subject — bigger triangle pointing in heading direction
      const sx = w2x(s.subjectPos?.x || 0);
      const sy = w2y(s.subjectPos?.z || 0);
      const head = s.subjectHeading || 0;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(-head + Math.PI / 2);
      ctx.fillStyle = '#6cf2ff';
      ctx.shadowColor = '#6cf2ff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 5);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // gaze cone
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(-(head + (s.gazeYaw || 0) * Math.PI / 180) + Math.PI / 2);
      ctx.fillStyle = 'rgba(108,242,255,.18)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 28, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      // axis labels
      ctx.font = '8px JetBrains Mono';
      ctx.fillStyle = 'rgba(160,185,205,.5)';
      ctx.fillText('N', W / 2 - 3, 30);
      ctx.fillText('S', W / 2 - 3, H - 6);
      ctx.fillText('W', 6, H / 2 + 3);
      ctx.fillText('E', W - 12, H / 2 + 3);
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    return () => { alive = false; };
  }, [active]);
  if (!active) return null;
  return (
    <div className="minimap">
      <canvas ref={ref} width={240} height={160}
              style={{ width: 240, height: 160, display: 'block' }} />
    </div>
  );
}

// ── Audio strip on the right edge ─────────────────────────────────────────
function AudioStrip({ active }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return;
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let alive = true;
    const W = cv.width, H = cv.height;
    let phase = 0;
    function draw() {
      if (!alive) return;
      ctx.clearRect(0, 0, W, H);
      const s = window.__sim?.state || {};
      const lvl = s.audioLevel || 0;
      const enabled = !!s.audioEnabled;
      ctx.strokeStyle = enabled ? 'rgba(108,242,255,.7)' : 'rgba(160,185,205,.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      phase += 0.06;
      for (let y = 0; y < H; y += 2) {
        // Pseudo-noise envelope (mix of sins) for live waveform feel
        const t = y * 0.06;
        const env = Math.sin(t + phase) * 0.4 + Math.sin(t * 2.3 + phase * 1.3) * 0.25
          + (Math.random() - 0.5) * 0.4;
        const amp = (W / 2 - 1) * env * lvl;
        if (y === 0) ctx.moveTo(W / 2 + amp, y);
        else ctx.lineTo(W / 2 + amp, y);
      }
      ctx.stroke();
      // center line
      ctx.strokeStyle = 'rgba(120,200,230,.16)';
      ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    return () => { alive = false; };
  }, [active]);
  if (!active) return null;
  return (
    <div className="audio-strip">
      <div className="lbl-v">AMBIENT</div>
      <canvas ref={ref} width={22} height={160}
              style={{ width: 22, height: 160, display: 'block' }} />
    </div>
  );
}

// ── Top center toolbar ────────────────────────────────────────────────────
function Toolbar({ params, set }) {
  const items = [
    { k: 'paused', label: params.paused ? '▶ RESUME' : '❚❚ PAUSE',
      onClick: () => set('paused', !params.paused), on: params.paused },
    { k: 'reset', label: '↺ RESET', onClick: () => window.__sim?.actions?.reset?.() },
    { k: 'autoWalk', label: 'AUTOWALK',
      onClick: () => set('autoWalk', !params.autoWalk), on: params.autoWalk },
    { k: 'audio', label: params.ambientAudio ? '♪ AUDIO' : '♪ MUTED',
      onClick: () => set('ambientAudio', !params.ambientAudio), on: params.ambientAudio },
    { k: 'tweaks', label: '⚙ TWEAKS', onClick: () => {
      window.parent.postMessage({ type: '__activate_edit_mode' }, '*');
    } },
  ];
  return (
    <div className="toolbar">
      {items.map((it) => (
        <div key={it.k} className={`seg ${it.on ? 'on' : ''}`} onClick={it.onClick}>
          {it.label}
        </div>
      ))}
    </div>
  );
}

// ── Conflict overlay banner (bottom-center, above minimap) ────────────────
function ConflictBanner({ s }) {
  const lvl = s.conflictLevel || 0;
  if (lvl < 0.5) return null;
  const ttc = s.nearestVehicle?.ttc;
  const ttcStr = isFinite(ttc) ? `TTC ${fmt(ttc, 1)}s` : 'CLOSE';
  return (
    <div style={{
      position: 'fixed', left: '50%', bottom: 200, transform: 'translateX(-50%)',
      padding: '6px 14px', border: '.5px solid var(--hud-red)',
      background: 'rgba(40, 8, 8, .65)', color: 'var(--hud-red)',
      fontFamily: 'var(--hud-mono)', fontSize: 11, letterSpacing: '.18em',
      textTransform: 'uppercase', textShadow: '0 0 8px rgba(255,90,90,.6)',
      animation: 'pulse 1.2s infinite', pointerEvents: 'none', zIndex: 7,
    }}>
      ⚠ CONFLICT POINT · {ttcStr} · LANE INCURSION
    </div>
  );
}

// ── Tweaks panel ─────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = window.__simParams;

function App() {
  // Bridge: useTweaks works against window.__simParams. We mirror useTweaks
  // values back to window.__simParams so sim.js sees the same source of truth.
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  useEffect(() => {
    Object.assign(window.__simParams, t);
  }, [t]);
  const s = useSimTick(10);

  return (
    <>
      <Toolbar params={t} set={setTweak} />
      {t.hudBio && <Biometrics s={s} />}
      {t.hudGaze && <GazeTracker s={s} />}
      {t.hudSafety && <SafetyPanel s={s} />}
      <SubjectCard s={s} />
      <Minimap active={!!t.hudMinimap} />
      <AudioStrip active={!!t.ambientAudio} />
      <ConflictBanner s={s} />
      <TweaksPanel title="Simulation Tweaks">
        <TweakSection label="Environment">
          <TweakSlider label="Time of day" value={t.timeOfDay} min={0} max={24} step={0.25}
                       unit="h" onChange={(v) => setTweak('timeOfDay', v)} />
          <TweakSelect label="Weather" value={t.weather}
                       options={[
                         { value: 'clear', label: 'Clear' },
                         { value: 'overcast', label: 'Overcast' },
                         { value: 'rain', label: 'Rain' },
                         { value: 'fog', label: 'Heavy fog' },
                       ]}
                       onChange={(v) => setTweak('weather', v)} />
        </TweakSection>
        <TweakSection label="Density">
          <TweakSlider label="Vehicle traffic" value={t.trafficDensity} min={0} max={100}
                       unit="%" onChange={(v) => setTweak('trafficDensity', v)} />
          <TweakSlider label="Pedestrians" value={t.pedDensity} min={0} max={100}
                       unit="%" onChange={(v) => setTweak('pedDensity', v)} />
        </TweakSection>
        <TweakSection label="Subject">
          <TweakSlider label="Walking speed" value={t.walkSpeed} min={0} max={2.5}
                       step={0.1} unit=" m/s" onChange={(v) => setTweak('walkSpeed', v)} />
          <TweakToggle label="Autowalk" value={t.autoWalk}
                       onChange={(v) => setTweak('autoWalk', v)} />
        </TweakSection>
        <TweakSection label="HUD layers">
          <TweakToggle label="Biometrics" value={t.hudBio}
                       onChange={(v) => setTweak('hudBio', v)} />
          <TweakToggle label="Gaze tracker" value={t.hudGaze}
                       onChange={(v) => setTweak('hudGaze', v)} />
          <TweakToggle label="Safety" value={t.hudSafety}
                       onChange={(v) => setTweak('hudSafety', v)} />
          <TweakToggle label="Minimap" value={t.hudMinimap}
                       onChange={(v) => setTweak('hudMinimap', v)} />
          <TweakToggle label="Conflict flash" value={t.showConflicts}
                       onChange={(v) => setTweak('showConflicts', v)} />
        </TweakSection>
        <TweakSection label="Audio">
          <TweakToggle label="Ambient soundscape" value={t.ambientAudio}
                       onChange={(v) => setTweak('ambientAudio', v)} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

// Mount
const root = ReactDOM.createRoot(document.getElementById('hud'));
root.render(<App />);
