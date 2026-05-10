/* sim.js — VR Urban Mobility Simulator scene
 * ─────────────────────────────────────────────────────────────────────────
 * Three.js first-person environment for studying pedestrian / cyclist
 * behavior at a single urban intersection. The "subject" is the camera —
 * they walk a counterclockwise loop around the SE corner of the
 * intersection, stopping at the curb when the WALK signal is red.
 *
 * Reads tweakable parameters from window.__simParams. Publishes live state
 * (speed, gaze, conflicts, nearest vehicle, agent positions, trajectory,
 * etc.) onto window.__sim so the React HUD can render it without coupling.
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const T = THREE;
  const PI = Math.PI, TAU = PI * 2;
  const DEG = 180 / PI;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const choice = (arr) => arr[(Math.random() * arr.length) | 0];
  const smooth = (t) => t * t * (3 - 2 * t);

  // ── World constants (meters) ─────────────────────────────────────────────
  const ROAD_W = 14;       // east-west road
  const CROSS_W = 14;      // north-south road
  const SIDEWALK = 4;
  const BIKELANE = 1.4;
  const CURB_H = 0.15;
  const EYE_H = 1.65;

  // Curb edges for the EW road (z extents) and the NS road (x extents).
  const ROAD_Z = ROAD_W / 2;            // ±7
  const ROAD_X = CROSS_W / 2;           // ±7
  const SIDEWALK_Z = ROAD_Z + SIDEWALK; // ±11
  const SIDEWALK_X = ROAD_X + SIDEWALK; // ±11

  // Bike lane is a strip just inside the curb on the EW road.
  const BIKE_Z_OUTER = ROAD_Z;
  const BIKE_Z_INNER = ROAD_Z - BIKELANE;

  // ── Public state ─────────────────────────────────────────────────────────
  const sim = (window.__sim = {
    started: false,
    state: {
      speed: 0, heartRate: 78,
      gazeYaw: 0, gazePitch: 0, fixationMs: 0, blinkRate: 14,
      gsr: 0.42, cognLoad: 0.3,
      nearestVehicle: { distance: 999, ttc: Infinity, bearing: 0, kind: '' },
      conflictLevel: 0, nearMisses: 0,
      sessionMs: 0,
      subjectPos: { x: -30, z: SIDEWALK_Z - 1.5 },
      subjectHeading: 0, // radians, 0 = +x
      walkPhase: 'walk', walkPhaseT: 0, walkPhaseDur: 1, walkRemaining: 0,
      vehicles: [], pedestrians: [], cyclists: [],
      trajectory: [],
      gazeTarget: null,
      audioEnabled: false,
      audioLevel: 0,
      lampsOn: false,
      sun: { az: 0, alt: 0 },
    },
    actions: {
      start: null,
      reset: null,
    },
  });

  // ── Renderer / scene / camera ────────────────────────────────────────────
  const container = document.getElementById('scene');
  const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.shadowMap.enabled = false; // perf — fake shadows via decals
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new T.Scene();
  scene.background = new T.Color(0x9bbac8);
  const fog = new T.Fog(0x9bbac8, 30, 180);
  scene.fog = fog;

  const camera = new T.PerspectiveCamera(72, 1, 0.1, 400);
  camera.position.set(-30, EYE_H, SIDEWALK_Z - 1.5);

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Sky (gradient via shader) ────────────────────────────────────────────
  const skyUniforms = {
    topColor: { value: new T.Color(0x4a7fb5) },
    bottomColor: { value: new T.Color(0xc9d6dc) },
    sunDir: { value: new T.Vector3(0.3, 0.8, 0.4) },
    sunColor: { value: new T.Color(0xfff0c0) },
    sunIntensity: { value: 0.7 },
  };
  const sky = new T.Mesh(
    new T.SphereGeometry(300, 32, 16),
    new T.ShaderMaterial({
      uniforms: skyUniforms,
      side: T.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `varying vec3 vWorld;
        void main() {
          vWorld = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor, bottomColor, sunDir, sunColor;
        uniform float sunIntensity;
        varying vec3 vWorld;
        void main() {
          float t = clamp(vWorld.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(bottomColor, topColor, pow(t, 0.7));
          float sd = max(dot(normalize(vWorld), normalize(sunDir)), 0.0);
          float sun = pow(sd, 240.0);
          float halo = pow(sd, 6.0) * 0.18;
          col += sunColor * (sun * 1.4 + halo) * sunIntensity;
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  scene.add(sky);

  // ── Lights ───────────────────────────────────────────────────────────────
  const sunLight = new T.DirectionalLight(0xfff0c0, 0.8);
  sunLight.position.set(60, 80, 30);
  scene.add(sunLight);
  const hemi = new T.HemisphereLight(0xb8d6e8, 0x404038, 0.5);
  scene.add(hemi);
  const ambient = new T.AmbientLight(0xffffff, 0.18);
  scene.add(ambient);

  // ── Materials ────────────────────────────────────────────────────────────
  const M = {
    asphalt: new T.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.92, metalness: 0.0 }),
    asphaltWet: new T.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.45, metalness: 0.05 }),
    sidewalk: new T.MeshStandardMaterial({ color: 0x9a9b97, roughness: 0.95 }),
    curb: new T.MeshStandardMaterial({ color: 0x6e7075, roughness: 0.9 }),
    bikelane: new T.MeshStandardMaterial({ color: 0x244a34, roughness: 0.85 }),
    line: new T.MeshBasicMaterial({ color: 0xf5f0d8, fog: true }),
    lineYel: new T.MeshBasicMaterial({ color: 0xf2c84a, fog: true }),
    crosswalk: new T.MeshBasicMaterial({ color: 0xeaeaea, fog: true }),
    grass: new T.MeshStandardMaterial({ color: 0x3a4d2a, roughness: 1 }),
    trunk: new T.MeshStandardMaterial({ color: 0x4a3322, roughness: 1 }),
    leaves: new T.MeshStandardMaterial({ color: 0x365e2c, roughness: 0.9 }),
    pole: new T.MeshStandardMaterial({ color: 0x222428, roughness: 0.7, metalness: 0.4 }),
    glassDark: new T.MeshStandardMaterial({ color: 0x101418, roughness: 0.4, metalness: 0.3 }),
    chrome: new T.MeshStandardMaterial({ color: 0xbcc2cc, roughness: 0.3, metalness: 0.7 }),
    rubber: new T.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9 }),
    skin: new T.MeshStandardMaterial({ color: 0xd9b298, roughness: 0.9 }),
    hatch: new T.MeshBasicMaterial({ color: 0xfff5d8 }),
  };

  // Building texture cache — different palettes for variety.
  function makeBuildingTexture(stories, bays, palette) {
    const W = bays * 28, H = stories * 38;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = palette.facade;
    ctx.fillRect(0, 0, W, H);
    // banding between floors
    ctx.fillStyle = palette.band;
    for (let s = 0; s < stories; s++) {
      ctx.fillRect(0, s * 38, W, 4);
    }
    // windows
    for (let s = 0; s < stories; s++) {
      for (let b = 0; b < bays; b++) {
        const x = b * 28 + 5, y = s * 38 + 8;
        const lit = Math.random();
        let fill;
        if (lit < palette.litChance) fill = palette.lit;
        else if (lit < palette.litChance + 0.05) fill = palette.lit2 || palette.lit;
        else fill = palette.window;
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, 18, 24);
        // mullion
        ctx.fillStyle = palette.frame;
        ctx.fillRect(x + 8, y, 2, 24);
        ctx.fillRect(x, y + 11, 18, 2);
      }
    }
    // ground floor — taller, retail-ish
    ctx.fillStyle = palette.ground || palette.band;
    ctx.fillRect(0, H - 22, W, 22);
    for (let b = 0; b < bays; b++) {
      ctx.fillStyle = b % 2 ? '#10141a' : '#1a1f26';
      ctx.fillRect(b * 28 + 4, H - 18, 20, 14);
    }
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    tex.magFilter = T.NearestFilter;
    tex.minFilter = T.LinearMipmapNearestFilter;
    tex.anisotropy = 4;
    return tex;
  }

  const buildingPalettes = [
    { facade: '#3a3530', band: '#262320', window: '#0e1218', lit: '#ffe9a8', lit2: '#a0c8ff', frame: '#1c1a18', ground: '#1f1c19', litChance: 0.18 },
    { facade: '#5a5048', band: '#3a342e', window: '#101418', lit: '#ffd58a', lit2: '#ffe1c8', frame: '#2a2620', ground: '#2a2520', litChance: 0.22 },
    { facade: '#262a30', band: '#161a20', window: '#0a0c10', lit: '#a0d0ff', lit2: '#fff2c8', frame: '#0e1116', ground: '#101218', litChance: 0.32 },
    { facade: '#4d4540', band: '#332c28', window: '#0c1014', lit: '#ffeac0', frame: '#1e1a16', ground: '#251f1c', litChance: 0.16 },
    { facade: '#7a6f60', band: '#564e44', window: '#10141a', lit: '#ffe0a0', frame: '#322c26', ground: '#3a322c', litChance: 0.12 },
    { facade: '#2c3340', band: '#1a2030', window: '#08101a', lit: '#80c8ff', lit2: '#ffd890', frame: '#10161e', ground: '#0e1218', litChance: 0.28 },
  ];

  // ── Static environment ───────────────────────────────────────────────────
  const env = new T.Group();
  scene.add(env);

  // Big base grass plane far away
  {
    const g = new T.Mesh(new T.PlaneGeometry(400, 400), M.grass);
    g.rotation.x = -PI / 2;
    g.position.y = -0.02;
    env.add(g);
  }

  // Roads (cross shape)
  const roadEW = new T.Mesh(new T.PlaneGeometry(400, ROAD_W), M.asphalt);
  roadEW.rotation.x = -PI / 2;
  roadEW.position.y = 0;
  env.add(roadEW);
  const roadNS = new T.Mesh(new T.PlaneGeometry(CROSS_W, 400), M.asphalt);
  roadNS.rotation.x = -PI / 2;
  roadNS.position.y = 0.001;
  env.add(roadNS);

  // Bike lanes — north and south strips on the EW road, broken by intersection
  function addBikeLane(zCenter) {
    const seg1 = new T.Mesh(new T.PlaneGeometry(200 - CROSS_W, BIKELANE), M.bikelane);
    seg1.rotation.x = -PI / 2;
    seg1.position.set(-100 - CROSS_W / 2 + 100, 0.002, zCenter); // left of intersection
    seg1.position.x = -(100 + CROSS_W / 2) / 2 - 0;
    env.add(seg1);
    // simpler: two strips
    seg1.position.set(-(100 + CROSS_W / 2) / 2, 0.002, zCenter);
    const seg2 = new T.Mesh(new T.PlaneGeometry(200 - CROSS_W, BIKELANE), M.bikelane);
    seg2.rotation.x = -PI / 2;
    seg2.position.set((100 + CROSS_W / 2) / 2, 0.002, zCenter);
    env.add(seg2);
  }
  addBikeLane(-(BIKE_Z_OUTER - BIKELANE / 2));
  addBikeLane(BIKE_Z_OUTER - BIKELANE / 2);

  // Sidewalks — four L-shaped corners around the intersection.
  function addSidewalkCorner(sx, sz) {
    // Long arm along EW
    const arm1 = new T.Mesh(
      new T.BoxGeometry(200 - CROSS_W, CURB_H, SIDEWALK),
      M.sidewalk
    );
    arm1.position.set(sx * (100 + CROSS_W / 2) / 2, CURB_H / 2,
      sz * (ROAD_W / 2 + SIDEWALK / 2));
    env.add(arm1);
    // Long arm along NS
    const arm2 = new T.Mesh(
      new T.BoxGeometry(SIDEWALK, CURB_H, 200 - ROAD_W),
      M.sidewalk
    );
    arm2.position.set(sx * (CROSS_W / 2 + SIDEWALK / 2), CURB_H / 2,
      sz * (100 + ROAD_W / 2) / 2);
    env.add(arm2);
    // corner block (square at the intersection)
    const corner = new T.Mesh(
      new T.BoxGeometry(SIDEWALK, CURB_H, SIDEWALK),
      M.sidewalk
    );
    corner.position.set(sx * (CROSS_W / 2 + SIDEWALK / 2), CURB_H / 2,
      sz * (ROAD_W / 2 + SIDEWALK / 2));
    env.add(corner);
  }
  addSidewalkCorner(+1, +1);
  addSidewalkCorner(-1, +1);
  addSidewalkCorner(+1, -1);
  addSidewalkCorner(-1, -1);

  // Lane markings — dashed center lines + edge lines on both roads.
  function addDashes(axis, lineColor, offset, length, gap, dashLen, count) {
    const mat = lineColor === 'yel' ? M.lineYel : M.line;
    const w = axis === 'x' ? dashLen : 0.15;
    const d = axis === 'x' ? 0.15 : dashLen;
    const start = -length / 2 + dashLen / 2;
    for (let i = 0; i < count; i++) {
      const at = start + i * (dashLen + gap);
      // skip pieces inside the intersection
      if (axis === 'x' && Math.abs(at) < CROSS_W / 2 + 1) continue;
      if (axis === 'z' && Math.abs(at) < ROAD_W / 2 + 1) continue;
      const m = new T.Mesh(new T.PlaneGeometry(w, d), mat);
      m.rotation.x = -PI / 2;
      if (axis === 'x') m.position.set(at, 0.005, offset);
      else m.position.set(offset, 0.005, at);
      env.add(m);
    }
  }
  // EW road center yellow
  addDashes('x', 'yel', 0.0, 200, 2.5, 4, 22);
  // EW road lane markers (white, one each side of yellow)
  addDashes('x', 'wht', -ROAD_W / 4, 200, 4, 3, 18);
  addDashes('x', 'wht',  ROAD_W / 4, 200, 4, 3, 18);
  // NS road
  addDashes('z', 'yel', 0.0, 200, 2.5, 4, 22);
  addDashes('z', 'wht', -CROSS_W / 4, 200, 4, 3, 18);
  addDashes('z', 'wht',  CROSS_W / 4, 200, 4, 3, 18);

  // Crosswalks — at all 4 sides of the intersection.
  function addCrosswalk(axis, side) {
    // axis 'x' = walking across the EW road (so crosswalk is a NS-oriented stripe block)
    const stripes = 7;
    for (let i = 0; i < stripes; i++) {
      const off = (i - (stripes - 1) / 2) * 0.9;
      let m;
      if (axis === 'x') {
        // stripes run EW (parallel to road); crosswalk crosses NS
        m = new T.Mesh(new T.PlaneGeometry(0.55, ROAD_W - 0.4), M.crosswalk);
        m.position.set(side * (CROSS_W / 2 + 1.2) + side * 0.0, 0.006, off);
        m.rotation.x = -PI / 2;
        m.position.x = side * (CROSS_W / 2 + 0.9);
      } else {
        m = new T.Mesh(new T.PlaneGeometry(CROSS_W - 0.4, 0.55), M.crosswalk);
        m.position.set(off, 0.006, side * (ROAD_W / 2 + 0.9));
        m.rotation.x = -PI / 2;
      }
      env.add(m);
    }
  }
  addCrosswalk('x', -1); addCrosswalk('x', +1);
  addCrosswalk('z', -1); addCrosswalk('z', +1);

  // Stop bars
  function addStopBar(axis, side) {
    let m;
    if (axis === 'x') {
      m = new T.Mesh(new T.PlaneGeometry(0.4, ROAD_W - 0.4), M.crosswalk);
      m.position.set(side * (CROSS_W / 2 + 2.0), 0.006, 0);
    } else {
      m = new T.Mesh(new T.PlaneGeometry(CROSS_W - 0.4, 0.4), M.crosswalk);
      m.position.set(0, 0.006, side * (ROAD_W / 2 + 2.0));
    }
    m.rotation.x = -PI / 2;
    env.add(m);
  }
  addStopBar('x', -1); addStopBar('x', +1);
  addStopBar('z', -1); addStopBar('z', +1);

  // ── Buildings ────────────────────────────────────────────────────────────
  function addBuilding(x, z, w, d, h, palette) {
    const stories = Math.max(2, Math.round(h / 3.5));
    const baysX = Math.max(2, Math.round(w / 3.5));
    const baysZ = Math.max(2, Math.round(d / 3.5));
    const pal = palette || choice(buildingPalettes);
    const texX = makeBuildingTexture(stories, baysX, pal);
    const texZ = makeBuildingTexture(stories, baysZ, pal);
    // assign per-face to wrap correctly
    const matSide = new T.MeshStandardMaterial({ map: texX, roughness: 0.85 });
    const matFront = new T.MeshStandardMaterial({ map: texZ, roughness: 0.85 });
    const matRoof = new T.MeshStandardMaterial({ color: 0x1a1c20, roughness: 1 });
    const mats = [matSide, matSide, matRoof, matRoof, matFront, matFront];
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), mats);
    m.position.set(x, h / 2, z);
    env.add(m);
    // roof crown
    const crown = new T.Mesh(new T.BoxGeometry(w * 0.96, 0.3, d * 0.96),
      new T.MeshStandardMaterial({ color: 0x16181c, roughness: 1 }));
    crown.position.set(x, h + 0.15, z);
    env.add(crown);
  }

  // Place buildings around all 4 corners. Variable heights for skyline interest.
  (function placeBuildings() {
    const corners = [[+1, +1], [-1, +1], [+1, -1], [-1, -1]];
    corners.forEach(([sx, sz]) => {
      // close to intersection
      let cx = sx * (SIDEWALK_X + 6);
      let cz = sz * (SIDEWALK_Z + 6);
      const heights = [22, 38, 16, 28, 44, 18, 32, 24];
      // Run N buildings along EW
      let off = 0;
      for (let i = 0; i < 4; i++) {
        const w = rand(10, 16), h = choice(heights), d = rand(10, 16);
        addBuilding(sx * (SIDEWALK_X + d / 2 + 0.4), h / 2, // unused
          0, 0, 0); // placeholder, replaced below
      }
    });

    // Above call was scaffolding; do the real placement here so positions
    // don't drift if I re-tune.
    env.children = env.children.filter((c) => !c.userData.__scaffold);
    const sides = [
      // (axis 'x'/'z', side -1/+1, axisOffsetCenter, count, lengthSpan)
      { axis: 'z', side: +1 }, // along south sidewalks (large z)
      { axis: 'z', side: -1 }, // along north sidewalks
      { axis: 'x', side: +1 }, // along east sidewalks
      { axis: 'x', side: -1 }, // along west sidewalks
    ];
    sides.forEach((s) => {
      const heights = [16, 22, 30, 38, 42, 28, 18, 24, 34];
      let cursor = -90;
      while (cursor < 90) {
        const w = rand(11, 18);
        const d = rand(11, 18);
        const h = choice(heights);
        // skip near intersection (let corner buildings sit further back)
        const center = cursor + w / 2;
        if (Math.abs(center) > CROSS_W / 2 + 5 || true) {
          if (s.axis === 'z') {
            // building lines the south/north sidewalk; long axis is x (=w), short is z (=d)
            const x = center;
            const z = s.side * (SIDEWALK_Z + d / 2 + 0.6);
            addBuilding(x, z, w, d, h);
          } else {
            // east/west sidewalk; long axis is z (=w), short is x (=d)
            const z = center;
            const x = s.side * (SIDEWALK_X + d / 2 + 0.6);
            addBuilding(x, z, d, w, h);
          }
        }
        cursor += w + rand(0.4, 1.2);
      }
    });
  })();

  // ── Street furniture ─────────────────────────────────────────────────────
  // Lamp posts on all four sidewalks
  const lampSpots = []; // for night glow updates
  function addLampPost(x, z, faceDir) {
    const post = new T.Mesh(new T.CylinderGeometry(0.07, 0.09, 5.5, 8), M.pole);
    post.position.set(x, 2.75, z);
    env.add(post);
    const arm = new T.Mesh(new T.BoxGeometry(1.2, 0.06, 0.06), M.pole);
    arm.position.set(x + faceDir * 0.6, 5.4, z);
    env.add(arm);
    const head = new T.Mesh(new T.BoxGeometry(0.5, 0.18, 0.3), M.pole);
    head.position.set(x + faceDir * 1.15, 5.35, z);
    env.add(head);
    const bulbMat = new T.MeshBasicMaterial({ color: 0x3a3128 });
    const bulb = new T.Mesh(new T.SphereGeometry(0.15, 12, 8), bulbMat);
    bulb.position.set(x + faceDir * 1.15, 5.2, z);
    env.add(bulb);
    const glow = new T.Mesh(
      new T.SphereGeometry(1.4, 10, 8),
      new T.MeshBasicMaterial({
        color: 0xffd896, transparent: true, opacity: 0,
        depthWrite: false, blending: T.AdditiveBlending,
      })
    );
    glow.position.copy(bulb.position);
    env.add(glow);
    lampSpots.push({ bulbMat, glow });
  }
  // Lamp posts every ~16m along the south & north sidewalks, both sides of intersection
  for (let x = -78; x <= 78; x += 16) {
    if (Math.abs(x) < CROSS_W / 2 + 3) continue;
    addLampPost(x, SIDEWALK_Z - 0.5, -1);
    addLampPost(x, -SIDEWALK_Z + 0.5, +1);
  }
  for (let z = -78; z <= 78; z += 16) {
    if (Math.abs(z) < ROAD_W / 2 + 3) continue;
    addLampPost(SIDEWALK_X - 0.5, z, -1);
    addLampPost(-SIDEWALK_X + 0.5, z, +1);
  }

  // Trees in tree-pits between lamp posts
  function addTree(x, z) {
    const trunkH = 3.2;
    const trunk = new T.Mesh(new T.CylinderGeometry(0.16, 0.22, trunkH, 7), M.trunk);
    trunk.position.set(x, trunkH / 2, z);
    env.add(trunk);
    const leaves = new T.Mesh(new T.IcosahedronGeometry(1.4, 0), M.leaves);
    leaves.position.set(x, trunkH + 1.0, z);
    leaves.scale.set(rand(0.9, 1.3), rand(0.9, 1.4), rand(0.9, 1.3));
    leaves.rotation.y = rand(0, TAU);
    env.add(leaves);
  }
  for (let x = -70; x <= 70; x += 16) {
    if (Math.abs(x) < CROSS_W / 2 + 3) continue;
    addTree(x, SIDEWALK_Z - 2.0);
    addTree(x, -SIDEWALK_Z + 2.0);
  }

  // ── Traffic lights ──────────────────────────────────────────────────────
  function makeTrafficLight() {
    const g = new T.Group();
    const post = new T.Mesh(new T.CylinderGeometry(0.08, 0.1, 5.0, 8), M.pole);
    post.position.y = 2.5;
    g.add(post);
    const arm = new T.Mesh(new T.BoxGeometry(2.0, 0.08, 0.08), M.pole);
    arm.position.set(1.0, 4.85, 0);
    g.add(arm);
    // Vehicle signal box
    const box = new T.Mesh(new T.BoxGeometry(0.55, 1.45, 0.5),
      new T.MeshStandardMaterial({ color: 0x111316, roughness: 0.7 }));
    box.position.set(1.95, 4.05, 0);
    g.add(box);
    const lamps = {};
    ['red', 'yellow', 'green'].forEach((c, i) => {
      const colors = { red: 0xff3b30, yellow: 0xffb030, green: 0x30d058 };
      const dimMat = new T.MeshBasicMaterial({ color: 0x14171a });
      const litMat = new T.MeshBasicMaterial({ color: colors[c] });
      const m = new T.Mesh(new T.CircleGeometry(0.16, 16), dimMat);
      m.position.set(2.21, 4.55 - i * 0.42, 0);
      m.rotation.y = PI / 2;
      g.add(m);
      const halo = new T.Mesh(
        new T.CircleGeometry(0.34, 16),
        new T.MeshBasicMaterial({ color: colors[c], transparent: true, opacity: 0,
          depthWrite: false, blending: T.AdditiveBlending })
      );
      halo.position.copy(m.position);
      halo.rotation.y = PI / 2;
      g.add(halo);
      lamps[c] = { mesh: m, halo, dimMat, litMat };
    });
    // Pedestrian signal box (smaller, on lower part of post)
    const pedBox = new T.Mesh(new T.BoxGeometry(0.4, 0.7, 0.36),
      new T.MeshStandardMaterial({ color: 0x111316, roughness: 0.7 }));
    pedBox.position.set(0, 2.6, 0.36);
    g.add(pedBox);
    const pedWalk = new T.Mesh(
      new T.PlaneGeometry(0.22, 0.22),
      new T.MeshBasicMaterial({ color: 0x14171a })
    );
    pedWalk.position.set(0, 2.78, 0.55);
    g.add(pedWalk);
    const pedHand = new T.Mesh(
      new T.PlaneGeometry(0.22, 0.22),
      new T.MeshBasicMaterial({ color: 0x14171a })
    );
    pedHand.position.set(0, 2.42, 0.55);
    g.add(pedHand);
    const pedWalkLit = new T.MeshBasicMaterial({ color: 0xeaffea });
    const pedHandLit = new T.MeshBasicMaterial({ color: 0xffb030 });
    return { group: g, lamps, pedWalk, pedHand, pedWalkLit, pedHandLit };
  }
  const lights = {
    NE: makeTrafficLight(), NW: makeTrafficLight(),
    SE: makeTrafficLight(), SW: makeTrafficLight(),
  };
  lights.NE.group.position.set(SIDEWALK_X - 0.6, 0, -SIDEWALK_Z + 0.6);
  lights.NE.group.rotation.y = PI;
  lights.NW.group.position.set(-SIDEWALK_X + 0.6, 0, -SIDEWALK_Z + 0.6);
  lights.NW.group.rotation.y = PI / 2;
  lights.SE.group.position.set(SIDEWALK_X - 0.6, 0, SIDEWALK_Z - 0.6);
  lights.SE.group.rotation.y = -PI / 2;
  lights.SW.group.position.set(-SIDEWALK_X + 0.6, 0, SIDEWALK_Z - 0.6);
  lights.SW.group.rotation.y = 0;
  Object.values(lights).forEach((l) => env.add(l.group));

  // Light cycle state. The EW road has green when NS has red, and vice versa.
  // Pedestrian crossing the EW road (subject's case) goes WALK when EW is RED.
  const tl = {
    phase: 'EW_GREEN', // EW_GREEN | EW_YELLOW | NS_GREEN | NS_YELLOW
    t: 0,
    durations: { EW_GREEN: 16, EW_YELLOW: 3, NS_GREEN: 14, NS_YELLOW: 3 },
  };
  function phaseFor(road) {
    // returns 'green' | 'yellow' | 'red'
    if (tl.phase === 'EW_GREEN') return road === 'EW' ? 'green' : 'red';
    if (tl.phase === 'EW_YELLOW') return road === 'EW' ? 'yellow' : 'red';
    if (tl.phase === 'NS_GREEN') return road === 'NS' ? 'green' : 'red';
    if (tl.phase === 'NS_YELLOW') return road === 'NS' ? 'yellow' : 'red';
    return 'red';
  }
  function pedPhaseFor(roadCrossed) {
    // PEDS crossing roadCrossed get WALK only during the OTHER axis's green,
    // FLASH during yellow on the other axis, otherwise DON'T WALK.
    const other = roadCrossed === 'EW' ? 'NS' : 'EW';
    const p = phaseFor(other);
    if (p === 'green') {
      // FLASH near end
      const phase = tl.phase;
      if ((other === 'EW' && phase === 'EW_GREEN') ||
          (other === 'NS' && phase === 'NS_GREEN')) {
        const left = tl.durations[phase] - tl.t;
        if (left < 4) return 'flash';
      }
      return 'walk';
    }
    return 'dont';
  }

  function updateLights(dt) {
    tl.t += dt;
    if (tl.t >= tl.durations[tl.phase]) {
      tl.t = 0;
      tl.phase = ({ EW_GREEN: 'EW_YELLOW', EW_YELLOW: 'NS_GREEN',
                    NS_GREEN: 'NS_YELLOW', NS_YELLOW: 'EW_GREEN' })[tl.phase];
    }
    // Update vehicle signal lamps. NE and SW face the EW road; NW and SE face the NS road.
    // Simpler: each light shows the phase of the road its arm points across.
    // We'll just show all 4 with the EW phase for the EW-direction lights.
    const ewP = phaseFor('EW'), nsP = phaseFor('NS');
    function setVeh(L, p) {
      ['red', 'yellow', 'green'].forEach((c) => {
        L.lamps[c].mesh.material = (p === c) ? L.lamps[c].litMat : L.lamps[c].dimMat;
        L.lamps[c].halo.material.opacity = (p === c) ? 0.55 : 0;
      });
    }
    // NE and SW face oncoming EW traffic; NW & SE face oncoming NS traffic
    setVeh(lights.NE, ewP);
    setVeh(lights.SW, ewP);
    setVeh(lights.NW, nsP);
    setVeh(lights.SE, nsP);
    // Ped signals — for crossing the EW road, mounted on the NS-facing posts (NW/NE on the north sidewalk; SW/SE on south).
    function setPed(L, p) {
      L.pedWalk.material = (p === 'walk') ? L.pedWalkLit
        : (p === 'flash' && Math.floor(tl.t * 2) % 2 === 0) ? L.pedWalkLit
        : new T.MeshBasicMaterial({ color: 0x14171a });
      L.pedHand.material = (p === 'walk') ? new T.MeshBasicMaterial({ color: 0x14171a })
        : (p === 'flash') ? L.pedHandLit
        : L.pedHandLit;
    }
    const pedEW = pedPhaseFor('EW'); // crossing the EW road (north-south direction)
    const pedNS = pedPhaseFor('NS'); // crossing the NS road (east-west direction)
    setPed(lights.NE, pedNS); setPed(lights.NW, pedNS);
    setPed(lights.SE, pedNS); setPed(lights.SW, pedNS);
    // (For peds crossing EW road we'd use pedEW on different signals; we re-use one
    // axis since the subject only crosses one road in the loop. Good enough.)
    sim.state.walkPhase = pedNS;
    sim.state.walkPhaseT = tl.t;
    sim.state.walkPhaseDur = tl.durations[tl.phase];
    sim.state.walkRemaining = Math.max(0, tl.durations[tl.phase] - tl.t);
  }

  // ── Vehicles ────────────────────────────────────────────────────────────
  const vehiclesGroup = new T.Group();
  scene.add(vehiclesGroup);
  const carColors = [0xb6342d, 0x2d4ab6, 0x303338, 0xe0e2e6, 0xc7c4ba, 0x2b5a3a, 0x9a8c5a, 0x4a4f58, 0xc4923a];

  function makeVehicle(kind = 'car') {
    const g = new T.Group();
    let chassisW, chassisL, chassisH, cabinW, cabinL, cabinH, color;
    if (kind === 'truck') {
      chassisW = 2.4; chassisL = 7.5; chassisH = 1.5; cabinW = 2.3; cabinL = 2.4; cabinH = 1.6;
      color = choice([0x6a4a2a, 0x4a4a4a, 0x2c2f33, 0x8a3a2a]);
    } else if (kind === 'bus') {
      chassisW = 2.5; chassisL = 11.5; chassisH = 2.6; cabinW = 0; cabinL = 0; cabinH = 0;
      color = choice([0xc4923a, 0x4a6a8a]);
    } else if (kind === 'taxi') {
      chassisW = 1.85; chassisL = 4.6; chassisH = 1.2; cabinW = 1.7; cabinL = 2.3; cabinH = 1.0;
      color = 0xe0c038;
    } else {
      chassisW = 1.8; chassisL = 4.4; chassisH = 1.2; cabinW = 1.7; cabinL = 2.2; cabinH = 0.95;
      color = choice(carColors);
    }
    const bodyMat = new T.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.5 });
    const chassis = new T.Mesh(new T.BoxGeometry(chassisL, chassisH, chassisW), bodyMat);
    chassis.position.y = chassisH / 2 + 0.35;
    g.add(chassis);
    if (cabinH > 0) {
      const cabin = new T.Mesh(new T.BoxGeometry(cabinL, cabinH, cabinW * 0.95), M.glassDark);
      cabin.position.set(-0.15, chassisH + cabinH / 2 + 0.32, 0);
      g.add(cabin);
    } else {
      // bus windows row
      for (let i = 0; i < 6; i++) {
        const w = new T.Mesh(new T.BoxGeometry(1.2, 0.8, 0.05), M.glassDark);
        w.position.set(-4.5 + i * 1.7, 1.7, chassisW / 2 - 0.02);
        g.add(w);
        const w2 = w.clone();
        w2.position.z = -chassisW / 2 + 0.02;
        g.add(w2);
      }
    }
    // Wheels
    const wheelGeom = new T.CylinderGeometry(0.36, 0.36, 0.28, 14);
    const axleSpan = chassisL * 0.32;
    [[axleSpan, 1], [axleSpan, -1], [-axleSpan, 1], [-axleSpan, -1]].forEach(([dx, sw]) => {
      const w = new T.Mesh(wheelGeom, M.rubber);
      w.rotation.x = PI / 2;
      w.position.set(dx, 0.36, sw * (chassisW / 2 + 0.02));
      g.add(w);
    });
    // Headlights — small emissive panels
    const hlMat = new T.MeshBasicMaterial({ color: 0xfff5d8 });
    const hlGeom = new T.PlaneGeometry(0.18, 0.12);
    [[chassisL / 2 + 0.01, chassisW / 2 - 0.25], [chassisL / 2 + 0.01, -chassisW / 2 + 0.25]]
      .forEach(([x, z]) => {
        const h = new T.Mesh(hlGeom, hlMat);
        h.position.set(x, 0.7, z);
        h.rotation.y = PI / 2;
        g.add(h);
      });
    // Taillights
    const tlMat = new T.MeshBasicMaterial({ color: 0x801010 });
    [[-chassisL / 2 - 0.01, chassisW / 2 - 0.25], [-chassisL / 2 - 0.01, -chassisW / 2 + 0.25]]
      .forEach(([x, z]) => {
        const h = new T.Mesh(hlGeom, tlMat);
        h.position.set(x, 0.7, z);
        h.rotation.y = -PI / 2;
        g.add(h);
      });
    return { group: g, kind, length: chassisL, headlightMat: hlMat, taillightMat: tlMat };
  }

  // Vehicle agents — each drives along its lane, stops at red lights, despawns.
  const vehicles = [];
  function spawnVehicle() {
    // Choose road and direction
    const onEW = Math.random() < 0.6;
    const dir = Math.random() < 0.5 ? +1 : -1;
    const kind = Math.random() < 0.08 ? 'bus' : Math.random() < 0.12 ? 'truck'
      : Math.random() < 0.1 ? 'taxi' : 'car';
    const v = makeVehicle(kind);
    // Lane offset from center: +dir means right side of road center per direction of travel.
    const laneOff = (dir > 0 ? 1 : -1) * (onEW ? ROAD_W / 4 : CROSS_W / 4);
    const startX = onEW ? -dir * 95 : laneOff;
    const startZ = onEW ? laneOff : -dir * 95;
    v.group.position.set(startX, 0, startZ);
    if (onEW) v.group.rotation.y = dir > 0 ? 0 : PI;
    else v.group.rotation.y = dir > 0 ? -PI / 2 : PI / 2;
    const speedMps = rand(8, 14); // ~30-50 km/h
    vehiclesGroup.add(v.group);
    vehicles.push({
      mesh: v, road: onEW ? 'EW' : 'NS', dir, laneOff, kind: v.kind,
      v: 0, vTarget: speedMps, length: v.length,
      pos: onEW ? startX : startZ,
    });
  }
  // Pre-populate with some vehicles
  for (let i = 0; i < 8; i++) spawnVehicle();

  function updateVehicles(dt, density01) {
    // spawn rate scales with density
    const spawnPerSec = lerp(0.05, 1.6, density01);
    if (Math.random() < spawnPerSec * dt && vehicles.length < 26) spawnVehicle();
    for (let i = vehicles.length - 1; i >= 0; i--) {
      const v = vehicles[i];
      // Stop at red bar
      const phase = phaseFor(v.road);
      // distance to stop bar (signed; positive means approaching)
      const stopBar = (v.road === 'EW' ? CROSS_W / 2 : ROAD_W / 2) + 0.5;
      const distToBar = -v.dir * v.pos - stopBar;
      // We want vehicles that are approaching (distToBar > 0 means they haven't reached it yet
      // in the direction of travel). v.dir > 0 moves +pos so distToBar = (-stopBar - pos) when dir +1? Let me redo.
      // Simpler: stopBarPos along the road (-dir * stopBar). Distance remaining = (stopBarPos - pos) * dir.
      const stopBarPos = -v.dir * stopBar;
      const remain = (stopBarPos - v.pos) * v.dir;
      const shouldStop = (phase === 'red' || phase === 'yellow') && remain > -1.0 && remain < 25;
      // Look-ahead for vehicle in front (very simple): find any vehicle in same road & dir & lane ahead
      let frontDist = Infinity;
      for (const o of vehicles) {
        if (o === v || o.road !== v.road || o.dir !== v.dir || o.laneOff !== v.laneOff) continue;
        const d = (o.pos - v.pos) * v.dir;
        if (d > 0 && d < frontDist) frontDist = d;
      }
      const desiredGap = 4.5 + v.v * 0.6;
      let target = v.vTarget;
      if (shouldStop && remain < (v.v * v.v) / 6 + 6) target = Math.min(target, Math.max(0, remain * 0.6));
      if (frontDist < desiredGap) target = Math.min(target, Math.max(0, (frontDist - 3.5) * 1.5));
      // accel toward target
      const a = (target > v.v ? 3.5 : 6.5);
      v.v += clamp(target - v.v, -a * dt, a * dt);
      v.v = Math.max(0, v.v);
      v.pos += v.v * v.dir * dt;
      // Apply position
      if (v.road === 'EW') v.mesh.group.position.x = v.pos;
      else v.mesh.group.position.z = v.pos;
      // Rotate wheels (visual approximation: slight z rotation on whole group? no — rotate wheels)
      // skip per-wheel rotation for perf; vehicles are far enough that wheel spin reads as motion blur
      // Headlights bright at night
      const lampsOn = sim.state.lampsOn;
      v.mesh.headlightMat.color.setHex(lampsOn ? 0xfff5d8 : 0xc8c0a8);
      v.mesh.taillightMat.color.setHex(v.v < 1 ? 0xff4040 : 0x801010);
      // Despawn
      if (Math.abs(v.pos) > 100) {
        vehiclesGroup.remove(v.mesh.group);
        vehicles.splice(i, 1);
      }
    }
  }

  // ── Pedestrians ─────────────────────────────────────────────────────────
  const pedsGroup = new T.Group();
  scene.add(pedsGroup);
  const skinTones = [0xd9b298, 0xb98c6e, 0x8a5e44, 0xf0c9a8, 0x6e4630];
  const clothColors = [0x2c3a4a, 0x6a3a2a, 0x4a4a4a, 0x7a3a4a, 0x3a5a7a, 0x8a8a3a, 0x5a3a7a, 0xc4a45a];

  function makePedestrian() {
    const g = new T.Group();
    const cloth = choice(clothColors);
    const skin = choice(skinTones);
    const body = new T.Mesh(
      new T.BoxGeometry(0.42, 0.7, 0.24),
      new T.MeshStandardMaterial({ color: cloth, roughness: 0.85 })
    );
    body.position.y = 1.05;
    g.add(body);
    const head = new T.Mesh(
      new T.SphereGeometry(0.13, 12, 10),
      new T.MeshStandardMaterial({ color: skin, roughness: 0.85 })
    );
    head.position.y = 1.55;
    g.add(head);
    // legs (separate so we can swing)
    const pants = new T.MeshStandardMaterial({ color: choice([0x1a1d22, 0x2a2520, 0x3a4050, 0x4a3a2a]), roughness: 0.85 });
    const legL = new T.Mesh(new T.BoxGeometry(0.17, 0.7, 0.18), pants);
    legL.position.set(-0.1, 0.35, 0);
    const legR = new T.Mesh(new T.BoxGeometry(0.17, 0.7, 0.18), pants);
    legR.position.set(0.1, 0.35, 0);
    g.add(legL, legR);
    // arms
    const armL = new T.Mesh(new T.BoxGeometry(0.12, 0.55, 0.14),
      new T.MeshStandardMaterial({ color: cloth, roughness: 0.85 }));
    armL.position.set(-0.27, 1.1, 0);
    const armR = armL.clone(); armR.position.x = 0.27;
    g.add(armL, armR);
    return { group: g, legL, legR, armL, armR };
  }

  const peds = [];
  function spawnPed() {
    const p = makePedestrian();
    pedsGroup.add(p.group);
    // Random origin and dest among spawn nodes (corner sidewalks + far-end sidewalks)
    const nodes = [
      { x: -90, z: SIDEWALK_Z - 1.5 }, { x: 90, z: SIDEWALK_Z - 1.5 },
      { x: -90, z: -SIDEWALK_Z + 1.5 }, { x: 90, z: -SIDEWALK_Z + 1.5 },
      { x: SIDEWALK_X - 1.5, z: 90 }, { x: SIDEWALK_X - 1.5, z: -90 },
      { x: -SIDEWALK_X + 1.5, z: 90 }, { x: -SIDEWALK_X + 1.5, z: -90 },
    ];
    const a = choice(nodes), b = choice(nodes.filter(n => n !== a));
    const speed = rand(0.9, 1.7);
    const ped = {
      mesh: p, pos: new T.Vector3(a.x, 0, a.z),
      dest: new T.Vector3(b.x, 0, b.z), speed, t: 0,
      crossing: false,
    };
    p.group.position.copy(ped.pos);
    return ped;
  }
  for (let i = 0; i < 8; i++) peds.push(spawnPed());

  function updatePedestrians(dt, density01) {
    // Spawn
    const target = Math.round(lerp(4, 24, density01));
    if (peds.length < target && Math.random() < 0.6 * dt + 0.05) {
      peds.push(spawnPed());
    }
    for (let i = peds.length - 1; i >= 0; i--) {
      const p = peds[i];
      const dx = p.dest.x - p.pos.x, dz = p.dest.z - p.pos.z;
      const distLeft = Math.hypot(dx, dz);
      if (distLeft < 0.5) {
        // arrived; remove or pick new dest
        if (Math.random() < 0.3) {
          pedsGroup.remove(p.mesh.group);
          peds.splice(i, 1);
          continue;
        } else {
          const nodes = [
            { x: -90, z: SIDEWALK_Z - 1.5 }, { x: 90, z: SIDEWALK_Z - 1.5 },
            { x: -90, z: -SIDEWALK_Z + 1.5 }, { x: 90, z: -SIDEWALK_Z + 1.5 },
            { x: SIDEWALK_X - 1.5, z: 90 }, { x: SIDEWALK_X - 1.5, z: -90 },
            { x: -SIDEWALK_X + 1.5, z: 90 }, { x: -SIDEWALK_X + 1.5, z: -90 },
          ];
          const b = choice(nodes);
          p.dest.set(b.x, 0, b.z);
          continue;
        }
      }
      // Simple A*: move along sidewalks via the nearest corner. We'll do a
      // greedy waypoint: if we're crossing the intersection, route via the
      // appropriate corner sidewalk.
      let waypoint = p.dest.clone();
      const px = p.pos.x, pz = p.pos.z;
      // If origin and dest are on different "sides" of the intersection (different sign of x or z)
      // we route via a corner.
      const sxOrig = px > 0 ? 1 : -1, szOrig = pz > 0 ? 1 : -1;
      const sxDest = p.dest.x > 0 ? 1 : -1, szDest = p.dest.z > 0 ? 1 : -1;
      if (sxOrig !== sxDest && szOrig !== szDest) {
        // Diagonal route — go via near corner
        waypoint.set(sxOrig * (SIDEWALK_X - 1.5), 0, szOrig * (SIDEWALK_Z - 1.5));
      } else if (sxOrig !== sxDest) {
        // Crossing the NS road — must use crosswalk on EW direction. Stop at curb if pedNS is dont/flash.
        const targetX = sxOrig * (CROSS_W / 2 + 1.5);
        // Go to crosswalk approach first
        if ((px - targetX) * sxOrig > 0) {
          waypoint.set(targetX, 0, p.pos.z);
        } else {
          // We're at curb; check signal
          const phase = pedPhaseFor('NS');
          if (phase === 'dont') {
            // wait — set waypoint = current pos
            waypoint.copy(p.pos);
          }
        }
      } else if (szOrig !== szDest) {
        const targetZ = szOrig * (ROAD_W / 2 + 1.5);
        if ((pz - targetZ) * szOrig > 0) {
          waypoint.set(p.pos.x, 0, targetZ);
        } else {
          const phase = pedPhaseFor('EW');
          if (phase === 'dont') waypoint.copy(p.pos);
        }
      }
      const wdx = waypoint.x - p.pos.x, wdz = waypoint.z - p.pos.z;
      const wd = Math.hypot(wdx, wdz);
      const moving = wd > 0.05;
      if (moving) {
        const step = Math.min(p.speed * dt, wd);
        p.pos.x += (wdx / wd) * step;
        p.pos.z += (wdz / wd) * step;
        p.mesh.group.position.copy(p.pos);
        p.mesh.group.rotation.y = Math.atan2(wdx, wdz) - PI / 2; // face direction
      }
      // walk anim
      p.t += dt * (moving ? 1 : 0);
      const swing = Math.sin(p.t * 8) * 0.5;
      p.mesh.legL.rotation.x = swing;
      p.mesh.legR.rotation.x = -swing;
      p.mesh.armL.rotation.x = -swing * 0.5;
      p.mesh.armR.rotation.x = swing * 0.5;
    }
  }

  // ── Cyclists ────────────────────────────────────────────────────────────
  const cyclistsGroup = new T.Group();
  scene.add(cyclistsGroup);
  function makeCyclist() {
    const g = new T.Group();
    // Bike frame
    const frameMat = new T.MeshStandardMaterial({ color: choice([0x222428, 0xb24038, 0x3a6a8a, 0x4a4a4a]), roughness: 0.5, metalness: 0.5 });
    const top = new T.Mesh(new T.BoxGeometry(0.9, 0.05, 0.05), frameMat);
    top.position.set(0, 0.7, 0);
    g.add(top);
    const seat = new T.Mesh(new T.BoxGeometry(0.18, 0.05, 0.1),
      new T.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1 }));
    seat.position.set(-0.4, 0.85, 0); g.add(seat);
    const wheelGeom = new T.TorusGeometry(0.32, 0.04, 8, 16);
    const wL = new T.Mesh(wheelGeom, M.rubber); wL.rotation.y = PI / 2; wL.position.set(0.5, 0.32, 0); g.add(wL);
    const wR = new T.Mesh(wheelGeom, M.rubber); wR.rotation.y = PI / 2; wR.position.set(-0.5, 0.32, 0); g.add(wR);
    // Rider
    const cloth = choice([0xb6342d, 0x2d4ab6, 0x303338, 0x3a5a7a, 0xc4923a]);
    const body = new T.Mesh(new T.BoxGeometry(0.4, 0.55, 0.22),
      new T.MeshStandardMaterial({ color: cloth, roughness: 0.8 }));
    body.position.set(-0.05, 1.15, 0);
    body.rotation.z = 0.3; // leaned forward
    g.add(body);
    const head = new T.Mesh(new T.SphereGeometry(0.13, 10, 8),
      new T.MeshStandardMaterial({ color: choice(skinTones), roughness: 0.85 }));
    head.position.set(0.05, 1.55, 0); g.add(head);
    const helmet = new T.Mesh(new T.SphereGeometry(0.15, 10, 8, 0, TAU, 0, PI / 2),
      new T.MeshStandardMaterial({ color: 0xffe04a, roughness: 0.6 }));
    helmet.position.set(0.05, 1.6, 0); g.add(helmet);
    return { group: g, wL, wR };
  }
  const cyclists = [];
  function spawnCyclist() {
    const c = makeCyclist();
    cyclistsGroup.add(c.group);
    const dir = Math.random() < 0.5 ? +1 : -1;
    const z = (dir > 0 ? +1 : -1) * (BIKE_Z_OUTER - BIKELANE / 2);
    const pos = -dir * 95;
    c.group.position.set(pos, 0, z);
    c.group.rotation.y = dir > 0 ? PI / 2 : -PI / 2;
    cyclists.push({ mesh: c, dir, pos, z, speed: rand(4.5, 7.5), v: 0 });
  }
  for (let i = 0; i < 3; i++) spawnCyclist();

  function updateCyclists(dt, density01) {
    if (Math.random() < lerp(0.02, 0.5, density01) * dt && cyclists.length < 8) spawnCyclist();
    for (let i = cyclists.length - 1; i >= 0; i--) {
      const c = cyclists[i];
      // stop at red on EW road
      const phase = phaseFor('EW');
      const stopBarPos = -c.dir * (CROSS_W / 2 + 0.6);
      const remain = (stopBarPos - c.pos) * c.dir;
      let target = c.speed;
      if ((phase === 'red' || phase === 'yellow') && remain > -0.5 && remain < 12) {
        target = Math.min(target, Math.max(0, remain * 0.5));
      }
      c.v += clamp(target - c.v, -8 * dt, 5 * dt);
      c.v = Math.max(0, c.v);
      c.pos += c.v * c.dir * dt;
      c.mesh.group.position.x = c.pos;
      // pedal animation
      c.mesh.wL.rotation.x += c.v * 0.4 * dt * 60 * 0.01;
      c.mesh.wR.rotation.x = c.mesh.wL.rotation.x;
      if (Math.abs(c.pos) > 100) {
        cyclistsGroup.remove(c.mesh.group);
        cyclists.splice(i, 1);
      }
    }
  }

  // ── Subject (camera) — state machine that walks counterclockwise around
  //    the SE corner, crossing one road each lap.
  // Loop:
  //   A: walk +x along south sidewalk (z = +SIDEWALK_Z-1.2)  from x=-30 to x=-CROSS_W/2-1
  //   B: wait at curb until pedNS == walk
  //   C: walk +x across the NS road  to x=+CROSS_W/2+1 (still on south side)
  //   D: walk +x along south sidewalk to x=+30
  //   E: turn around — walk -x back. (or teleport via fade)
  // For simplicity we'll loop east-west along the south sidewalk crossing the NS road repeatedly.
  // ────────────────────────────────────────────────────────────────────────
  const subj = {
    state: 'WALK_E',           // WALK_E | WAIT_CURB_E | CROSS_E | WALK_W | WAIT_CURB_W | CROSS_W
    pos: new T.Vector3(-30, EYE_H, SIDEWALK_Z - 1.2),
    facing: 0,                 // yaw radians; 0 = +x
    targetFacing: 0,
    walkSpeedTarget: 1.4,
    walkSpeed: 0,
    bobT: 0,
    headSwayT: 0,
    gazeYaw: 0, gazePitch: 0,
    gazeTargetYaw: 0, gazeTargetPitch: 0,
    fixationStart: 0,
  };

  function updateSubject(dt) {
    const params = window.__simParams;
    const speedTgt = params.autoWalk ? params.walkSpeed : 0;
    subj.walkSpeedTarget = speedTgt;

    // Determine logical motion based on state machine
    let want = 0; // forward speed 0..target
    let yawTarget = subj.facing;
    const px = subj.pos.x, pz = subj.pos.z;
    const curbE_x = +CROSS_W / 2 + 0.4;
    const curbW_x = -CROSS_W / 2 - 0.4;
    const farE_x = +30, farW_x = -30;

    switch (subj.state) {
      case 'WALK_E':
        yawTarget = 0;
        want = speedTgt;
        if (px >= curbW_x - 0.4) {
          subj.state = 'WAIT_CURB_E';
        }
        break;
      case 'WAIT_CURB_E':
        yawTarget = 0;
        want = 0;
        // wait until walk
        if (sim.state.walkPhase === 'walk' && sim.state.walkRemaining > 6) {
          subj.state = 'CROSS_E';
        }
        break;
      case 'CROSS_E':
        yawTarget = 0;
        want = speedTgt;
        if (px >= curbE_x + 1.2) subj.state = 'WALK_E2';
        break;
      case 'WALK_E2':
        yawTarget = 0;
        want = speedTgt;
        if (px >= farE_x) {
          subj.state = 'TURN_W';
          subj.turnT = 0;
        }
        break;
      case 'TURN_W':
        yawTarget = PI;
        want = 0;
        subj.turnT = (subj.turnT || 0) + dt;
        if (subj.turnT > 1.6) subj.state = 'WALK_W';
        break;
      case 'WALK_W':
        yawTarget = PI;
        want = speedTgt;
        if (px <= curbE_x + 0.4) subj.state = 'WAIT_CURB_W';
        break;
      case 'WAIT_CURB_W':
        yawTarget = PI;
        want = 0;
        if (sim.state.walkPhase === 'walk' && sim.state.walkRemaining > 6) {
          subj.state = 'CROSS_W';
        }
        break;
      case 'CROSS_W':
        yawTarget = PI;
        want = speedTgt;
        if (px <= curbW_x - 1.2) subj.state = 'WALK_W2';
        break;
      case 'WALK_W2':
        yawTarget = PI;
        want = speedTgt;
        if (px <= farW_x) {
          subj.state = 'TURN_E';
          subj.turnT = 0;
        }
        break;
      case 'TURN_E':
        yawTarget = 0;
        want = 0;
        subj.turnT = (subj.turnT || 0) + dt;
        if (subj.turnT > 1.6) subj.state = 'WALK_E';
        break;
      default:
        subj.state = 'WALK_E';
    }
    subj.targetFacing = yawTarget;

    // Smooth speed
    const accel = 1.2;
    subj.walkSpeed += clamp(want - subj.walkSpeed, -accel * dt, accel * dt);
    subj.walkSpeed = Math.max(0, subj.walkSpeed);

    // Smooth facing (shortest angle)
    let dyaw = yawTarget - subj.facing;
    while (dyaw > PI) dyaw -= TAU;
    while (dyaw < -PI) dyaw += TAU;
    subj.facing += clamp(dyaw, -1.6 * dt, 1.6 * dt);

    // Move
    subj.pos.x += Math.cos(subj.facing) * subj.walkSpeed * dt;
    subj.pos.z += -Math.sin(subj.facing) * subj.walkSpeed * dt;
    // Stay on south sidewalk z (or on crosswalk when crossing — but we're crossing along x only,
    // so z stays the same; when crossing the NS road the subject is on the EW crosswalk at z near +SIDEWALK_Z-1.2)
    // Snap z to the sidewalk track (+SIDEWALK_Z - 1.2) with a small lateral wander
    const lateralWander = Math.sin(performance.now() * 0.0007) * 0.08;
    subj.pos.z = SIDEWALK_Z - 1.2 + lateralWander;

    // Head bob
    subj.bobT += subj.walkSpeed * 1.8 * dt;
    const bobY = Math.sin(subj.bobT) * 0.04 * (subj.walkSpeed / 1.4);
    const bobX = Math.cos(subj.bobT * 0.5) * 0.03 * (subj.walkSpeed / 1.4);

    // Gaze: occasionally fixate on nearest vehicle/cyclist/ped
    subj.headSwayT += dt;
    if (subj.headSwayT > rand(1.6, 3.5)) {
      subj.headSwayT = 0;
      // pick a target — nearest moving agent within view cone
      const cands = [];
      vehicles.forEach((v) => cands.push({ kind: 'vehicle', x: v.mesh.group.position.x, z: v.mesh.group.position.z, vmps: v.v }));
      peds.forEach((p) => cands.push({ kind: 'pedestrian', x: p.pos.x, z: p.pos.z, vmps: p.speed }));
      cyclists.forEach((c) => cands.push({ kind: 'cyclist', x: c.mesh.group.position.x, z: c.mesh.group.position.z, vmps: c.v }));
      let best = null, bestScore = Infinity;
      for (const c of cands) {
        const dx = c.x - subj.pos.x, dz = c.z - subj.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 4 || d > 50) continue;
        const ang = Math.atan2(-dz, dx) - subj.facing;
        let a = ang; while (a > PI) a -= TAU; while (a < -PI) a += TAU;
        if (Math.abs(a) > 1.1) continue;
        const score = d - c.vmps * 0.5 + Math.abs(a) * 5;
        if (score < bestScore) { bestScore = score; best = { ...c, ang: a }; }
      }
      if (best) {
        subj.gazeTargetYaw = best.ang;
        subj.gazeTargetPitch = -0.05;
        sim.state.gazeTarget = { kind: best.kind, distance: Math.hypot(best.x - subj.pos.x, best.z - subj.pos.z) };
        subj.fixationStart = performance.now();
      } else {
        subj.gazeTargetYaw = rand(-0.3, 0.3);
        subj.gazeTargetPitch = rand(-0.05, 0.05);
        sim.state.gazeTarget = null;
      }
    }
    // Smoothly converge gaze
    subj.gazeYaw += (subj.gazeTargetYaw - subj.gazeYaw) * Math.min(1, dt * 6);
    subj.gazePitch += (subj.gazeTargetPitch - subj.gazePitch) * Math.min(1, dt * 6);

    // Apply to camera
    camera.position.set(subj.pos.x + bobX, subj.pos.y + bobY, subj.pos.z);
    const yaw = subj.facing + subj.gazeYaw;
    const pitch = subj.gazePitch;
    const lookAt = new T.Vector3(
      camera.position.x + Math.cos(yaw) * Math.cos(pitch),
      camera.position.y + Math.sin(pitch),
      camera.position.z - Math.sin(yaw) * Math.cos(pitch)
    );
    camera.lookAt(lookAt);

    // Update sim state
    sim.state.subjectPos.x = subj.pos.x;
    sim.state.subjectPos.z = subj.pos.z;
    sim.state.subjectHeading = subj.facing;
    sim.state.speed = subj.walkSpeed;
    sim.state.gazeYaw = subj.gazeYaw * DEG;
    sim.state.gazePitch = subj.gazePitch * DEG;
    sim.state.fixationMs = sim.state.gazeTarget ? (performance.now() - subj.fixationStart) : 0;

    // Trajectory log every 0.4s
    sim.__trajectoryT = (sim.__trajectoryT || 0) + dt;
    if (sim.__trajectoryT > 0.4) {
      sim.__trajectoryT = 0;
      sim.state.trajectory.push({ x: subj.pos.x, z: subj.pos.z });
      if (sim.state.trajectory.length > 200) sim.state.trajectory.shift();
    }
  }

  // ── Conflict / TTC computation ──────────────────────────────────────────
  function updateConflicts() {
    let nearest = null; let minTTC = Infinity;
    const sx = subj.pos.x, sz = subj.pos.z;
    for (const v of vehicles) {
      const vx = v.mesh.group.position.x, vz = v.mesh.group.position.z;
      const dx = vx - sx, dz = vz - sz;
      const d = Math.hypot(dx, dz);
      if (d > 70) continue;
      // velocity vector
      let vvx = 0, vvz = 0;
      if (v.road === 'EW') vvx = v.v * v.dir; else vvz = v.v * v.dir;
      // closing rate along subject->vehicle vector
      const ux = -dx / d, uz = -dz / d;
      const closing = vvx * ux + vvz * uz;
      const ttc = closing > 0.1 ? d / closing : Infinity;
      if (d < minTTC * 5 && ttc < minTTC * 1.5) {
        if (!nearest || d < nearest.d) {
          nearest = { d, ttc, kind: v.kind, bearing: Math.atan2(-dz, dx) - subj.facing };
        }
      }
    }
    if (nearest) {
      sim.state.nearestVehicle.distance = nearest.d;
      sim.state.nearestVehicle.ttc = nearest.ttc;
      sim.state.nearestVehicle.kind = nearest.kind;
      let b = nearest.bearing; while (b > PI) b -= TAU; while (b < -PI) b += TAU;
      sim.state.nearestVehicle.bearing = b * DEG;
      // conflict level
      let lvl = 0;
      if (nearest.d < 12 && (subj.state === 'CROSS_E' || subj.state === 'CROSS_W')) lvl = clamp(1 - nearest.d / 12, 0, 1);
      if (nearest.ttc < 4) lvl = Math.max(lvl, clamp(1 - nearest.ttc / 4, 0, 1));
      sim.state.conflictLevel = lvl;
      // near miss flash
      if (lvl > 0.7 && (sim.__lastFlash || 0) + 4000 < performance.now()) {
        sim.__lastFlash = performance.now();
        sim.state.nearMisses++;
        const f = document.getElementById('conflict-flash');
        if (f) {
          f.classList.add('on');
          setTimeout(() => f.classList.remove('on'), 400);
        }
      }
    } else {
      sim.state.nearestVehicle.distance = 999;
      sim.state.nearestVehicle.ttc = Infinity;
      sim.state.conflictLevel = 0;
    }
    // biometrics drift toward conflict
    const target = 78 + sim.state.conflictLevel * 32 + (subj.state.startsWith('CROSS') ? 8 : 0);
    sim.state.heartRate += (target - sim.state.heartRate) * 0.02;
    sim.state.gsr += ((0.4 + sim.state.conflictLevel * 0.5) - sim.state.gsr) * 0.03;
    sim.state.cognLoad += ((0.3 + sim.state.conflictLevel * 0.6 + (subj.state.startsWith('CROSS') ? 0.2 : 0)) - sim.state.cognLoad) * 0.04;
    sim.state.blinkRate = 14 + (subj.state.startsWith('CROSS') ? -3 : 0) + sim.state.conflictLevel * -2;
  }

  // ── Time of day / weather ───────────────────────────────────────────────
  // Maps tweak parameters to scene visuals.
  const rainGroup = new T.Group();
  scene.add(rainGroup);
  let rainPoints = null;

  function ensureRain(on) {
    if (on && !rainPoints) {
      const N = 1500;
      const pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        pos[i * 3] = rand(-50, 50);
        pos[i * 3 + 1] = rand(0, 30);
        pos[i * 3 + 2] = rand(-50, 50);
      }
      const geom = new T.BufferGeometry();
      geom.setAttribute('position', new T.BufferAttribute(pos, 3));
      const mat = new T.PointsMaterial({ color: 0xa8c0d0, size: 0.06, transparent: true, opacity: 0.6, depthWrite: false });
      rainPoints = new T.Points(geom, mat);
      rainGroup.add(rainPoints);
    } else if (!on && rainPoints) {
      rainGroup.remove(rainPoints);
      rainPoints.geometry.dispose();
      rainPoints.material.dispose();
      rainPoints = null;
    }
  }

  function updateRain(dt) {
    if (!rainPoints) return;
    const pos = rainPoints.geometry.attributes.position.array;
    const cx = camera.position.x, cz = camera.position.z;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i + 1] -= 18 * dt;
      if (pos[i + 1] < 0) {
        pos[i] = cx + rand(-50, 50);
        pos[i + 1] = rand(15, 30);
        pos[i + 2] = cz + rand(-50, 50);
      }
    }
    rainPoints.geometry.attributes.position.needsUpdate = true;
  }

  function updateTimeOfDay() {
    const params = window.__simParams;
    const hour = params.timeOfDay;
    // sun altitude: 0 at 6/18, peak at 12
    const altDeg = Math.sin((hour - 6) / 12 * PI) * 70;
    const azDeg = (hour - 12) * 15; // east in morning, west in evening
    const altRad = altDeg * (PI / 180), azRad = azDeg * (PI / 180);
    const sunDir = new T.Vector3(
      Math.sin(azRad) * Math.cos(altRad),
      Math.sin(altRad),
      -Math.cos(azRad) * Math.cos(altRad)
    );
    sunLight.position.copy(sunDir).multiplyScalar(120);
    skyUniforms.sunDir.value.copy(sunDir);

    // Color palettes for sky / sun based on hour
    let skyTop, skyBot, sunCol, sunInt, sunlightCol, sunlightInt, ambInt, hemiInt;
    if (hour < 5 || hour > 21) {
      // night
      skyTop = new T.Color(0x06090f); skyBot = new T.Color(0x12182a);
      sunCol = new T.Color(0x222a40); sunInt = 0.05;
      sunlightCol = new T.Color(0x405068); sunlightInt = 0.05;
      ambInt = 0.06; hemiInt = 0.18;
      sim.state.lampsOn = true;
    } else if (hour < 7 || hour > 19) {
      // dawn/dusk
      const golden = (hour < 7) ? (hour - 5) / 2 : (21 - hour) / 2;
      skyTop = new T.Color(0x2a3a5a).lerp(new T.Color(0xf08c4a), 0.4);
      skyBot = new T.Color(0xf0a868);
      sunCol = new T.Color(0xff9050); sunInt = 0.9;
      sunlightCol = new T.Color(0xffc080); sunlightInt = 0.7;
      ambInt = 0.15; hemiInt = 0.4;
      sim.state.lampsOn = true;
    } else if (hour < 9 || hour > 17) {
      // morning/late afternoon
      skyTop = new T.Color(0x4a7fb5); skyBot = new T.Color(0xd2c8b8);
      sunCol = new T.Color(0xfff0c0); sunInt = 0.8;
      sunlightCol = new T.Color(0xfff0c8); sunlightInt = 0.85;
      ambInt = 0.2; hemiInt = 0.5;
      sim.state.lampsOn = false;
    } else {
      // midday
      skyTop = new T.Color(0x4a8fcf); skyBot = new T.Color(0xc6d8e0);
      sunCol = new T.Color(0xfff8e0); sunInt = 0.7;
      sunlightCol = new T.Color(0xffffff); sunlightInt = 1.0;
      ambInt = 0.28; hemiInt = 0.6;
      sim.state.lampsOn = false;
    }

    // Weather adjustments
    const w = params.weather;
    if (w === 'overcast') {
      skyTop.lerp(new T.Color(0x6a7280), 0.7);
      skyBot.lerp(new T.Color(0x9ca0a8), 0.7);
      sunInt *= 0.2; sunlightInt *= 0.5; hemiInt *= 0.85;
    } else if (w === 'rain') {
      skyTop.lerp(new T.Color(0x40484f), 0.85);
      skyBot.lerp(new T.Color(0x6a7080), 0.85);
      sunInt *= 0.05; sunlightInt *= 0.35; hemiInt *= 0.7; ambInt *= 0.9;
      sim.state.lampsOn = true;
    } else if (w === 'fog') {
      skyTop.lerp(new T.Color(0x9aa0a8), 0.85);
      skyBot.lerp(new T.Color(0xc0c4c8), 0.85);
      sunInt *= 0.15; sunlightInt *= 0.5; hemiInt *= 0.95;
    }

    skyUniforms.topColor.value.copy(skyTop);
    skyUniforms.bottomColor.value.copy(skyBot);
    skyUniforms.sunColor.value.copy(sunCol);
    skyUniforms.sunIntensity.value = sunInt;
    sunLight.color.copy(sunlightCol);
    sunLight.intensity = sunlightInt;
    ambient.intensity = ambInt;
    hemi.intensity = hemiInt;

    // Fog tuning
    let fogColor = skyBot.clone().lerp(skyTop, 0.3);
    let fogNear = 60, fogFar = 220;
    if (w === 'fog') { fogNear = 12; fogFar = 80; fogColor = new T.Color(0xc0c4c8); }
    else if (w === 'rain') { fogNear = 30; fogFar = 130; fogColor = new T.Color(0x4c5460); }
    else if (w === 'overcast') { fogNear = 50; fogFar = 200; }
    fog.color.copy(fogColor);
    fog.near = fogNear; fog.far = fogFar;
    scene.background = fogColor.clone().lerp(skyTop, 0.6);

    // Asphalt wet vs dry
    if (w === 'rain') roadEW.material = roadNS.material = M.asphaltWet;
    else roadEW.material = roadNS.material = M.asphalt;

    // Lamp glow
    const glowOn = sim.state.lampsOn ? 1 : 0;
    lampSpots.forEach((l) => {
      l.bulbMat.color.setHex(glowOn ? 0xffe0a8 : 0x3a3128);
      l.glow.material.opacity = glowOn ? 0.35 : 0;
    });

    // Rain particles
    ensureRain(w === 'rain');

    sim.state.sun.az = azDeg;
    sim.state.sun.alt = altDeg;
    sim.state.weather = w;
    sim.state.timeOfDay = hour;
  }

  // ── Audio (ambient white-noise based city soundscape) ───────────────────
  let audioCtx = null, audioMaster = null, audioNodes = null;
  function ensureAudio() {
    if (audioCtx) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }
    audioMaster = audioCtx.createGain();
    audioMaster.gain.value = 0.0;
    audioMaster.connect(audioCtx.destination);

    // Brown-ish noise buffer for city rumble
    const len = audioCtx.sampleRate * 4;
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 800;
    const noiseGain = audioCtx.createGain(); noiseGain.gain.value = 0.5;
    noise.connect(lp).connect(noiseGain).connect(audioMaster);
    noise.start();

    // Higher hiss for "swoosh" feel
    const buf2 = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data2 = buf2.getChannelData(0);
    for (let i = 0; i < len; i++) data2[i] = (Math.random() * 2 - 1) * 0.5;
    const hiss = audioCtx.createBufferSource();
    hiss.buffer = buf2; hiss.loop = true;
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'bandpass'; hp.frequency.value = 2200; hp.Q.value = 0.7;
    const hissGain = audioCtx.createGain(); hissGain.gain.value = 0.08;
    hiss.connect(hp).connect(hissGain).connect(audioMaster);
    hiss.start();

    audioNodes = { lp, noiseGain, hp, hissGain };
  }
  function setAudioOn(on) {
    if (!audioCtx) return;
    audioMaster.gain.cancelScheduledValues(audioCtx.currentTime);
    audioMaster.gain.linearRampToValueAtTime(on ? 0.12 : 0, audioCtx.currentTime + 0.5);
    sim.state.audioEnabled = on;
  }
  function tweakAudioByScene() {
    if (!audioCtx || !audioNodes) return;
    const w = window.__simParams.weather;
    // Rain — open up filter, raise hiss
    if (w === 'rain') {
      audioNodes.lp.frequency.setTargetAtTime(1400, audioCtx.currentTime, 1.5);
      audioNodes.hissGain.gain.setTargetAtTime(0.22, audioCtx.currentTime, 1.5);
    } else if (w === 'fog') {
      audioNodes.lp.frequency.setTargetAtTime(500, audioCtx.currentTime, 1.5);
      audioNodes.hissGain.gain.setTargetAtTime(0.04, audioCtx.currentTime, 1.5);
    } else {
      audioNodes.lp.frequency.setTargetAtTime(900, audioCtx.currentTime, 1.5);
      audioNodes.hissGain.gain.setTargetAtTime(0.08, audioCtx.currentTime, 1.5);
    }
    // City density modulates volume
    const dens = (window.__simParams.trafficDensity + window.__simParams.pedDensity) / 200;
    sim.state.audioLevel = lerp(0.3, 1, dens);
  }

  // Action: start (called by splash gesture)
  sim.actions.start = function () {
    sim.started = true;
    ensureAudio();
    if (window.__simParams.ambientAudio) setAudioOn(true);
  };
  sim.actions.reset = function () {
    subj.pos.set(-30, EYE_H, SIDEWALK_Z - 1.2);
    subj.facing = 0; subj.targetFacing = 0; subj.walkSpeed = 0;
    subj.state = 'WALK_E';
    sim.state.trajectory.length = 0;
    sim.state.nearMisses = 0;
    sim.state.sessionMs = 0;
  };

  // ── Animate loop ─────────────────────────────────────────────────────────
  let lastT = performance.now();
  function frame() {
    const now = performance.now();
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.1) dt = 0.1;
    const params = window.__simParams;
    const paused = !!params.paused;
    const simDt = paused ? 0 : dt;

    sim.state.sessionMs += simDt * 1000;
    if (sim.started) {
      updateLights(simDt);
      updateVehicles(simDt, params.trafficDensity / 100);
      updatePedestrians(simDt, params.pedDensity / 100);
      updateCyclists(simDt, params.trafficDensity / 100);
      updateSubject(simDt);
      updateRain(simDt);
      updateConflicts();
    }
    updateTimeOfDay();
    tweakAudioByScene();
    if (audioCtx) {
      const want = !!params.ambientAudio;
      if (want !== sim.state.audioEnabled) setAudioOn(want);
    }
    // expose live agent samples for HUD minimap (limit count)
    sim.state.vehicles = vehicles.slice(0, 30).map((v) => ({
      x: v.mesh.group.position.x, z: v.mesh.group.position.z,
      dir: v.dir, road: v.road, kind: v.kind, v: v.v,
    }));
    sim.state.pedestrians = peds.slice(0, 40).map((p) => ({ x: p.pos.x, z: p.pos.z }));
    sim.state.cyclists = cyclists.slice(0, 12).map((c) => ({ x: c.mesh.group.position.x, z: c.mesh.group.position.z }));

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Splash — first user gesture starts audio + sim
  const splash = document.getElementById('splash');
  if (splash) {
    splash.addEventListener('click', () => {
      sim.actions.start();
      splash.classList.add('hide');
      setTimeout(() => splash.remove(), 800);
    }, { once: true });
  } else {
    sim.actions.start();
  }

  // Compass strip update — done outside React for smooth motion
  const compassStrip = document.getElementById('compass-strip');
  if (compassStrip) {
    // Build ticks from 0..360 every 5°, with N/E/S/W at quadrants
    const html = [];
    for (let d = -180; d < 540; d += 5) {
      const dn = ((d % 360) + 360) % 360;
      const major = dn % 90 === 0;
      const lbl = major ? ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[dn]
        : (dn % 15 === 0 ? String(dn) : '·');
      html.push(`<div class="tick ${major ? 'major' : ''}">${lbl}</div>`);
    }
    compassStrip.innerHTML = html.join('');
  }
  function updateCompass() {
    if (!compassStrip) return;
    // heading: 0 rad = +x = "East"; convert to degrees with N=0 (so we add 90)
    const headingDeg = (-sim.state.subjectHeading * DEG + 90 + 360) % 360;
    const tickW = 20;
    // Strip covers -180 to 540 (720°), centered. We want headingDeg to align with viewport center.
    // The strip's "0°" tick is at index (180/5)=36 → 36*20=720px from strip-left.
    const stripWidth = 720 / 5 * 20; // total ticks * tickW
    const offsetX = -(36 * tickW + (headingDeg / 5) * tickW) + 160; // 320/2 = 160
    compassStrip.style.transform = `translateX(${offsetX}px)`;
    requestAnimationFrame(updateCompass);
  }
  updateCompass();
})();
