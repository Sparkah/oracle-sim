// 3D arena. Owns movement, cameras and effects; owns NOTHING about the outcome.
//
// Same contract as the 2D renderer next door: it is handed a finished bout - a timeline the
// model already committed to - and it stages a fight that arrives exactly there. The bots
// close, trade the scripted exchange, break off, and repeat. If the visuals rolled their own
// dice you could watch a 90% favourite lose on stage while the bar above it still read 90%,
// and that reads as broken rather than as variance.
//
// Fighters are real CC0 rigged mechs (Quaternius, Animated Mech Pack) with their own Idle /
// Run / Punch / Kick / SwordSlash / HitRecieve / Death / Dance clips. Weapons are built in
// code because no free pack ships a BattleBots undercutter, and they are the one thing that
// has to match the scraped `weapon` field exactly.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clone as skinnedClone } from 'three/addons/utils/SkeletonUtils.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

export const CORNER = { a: 0xe8503a, b: 0x3da9fc };

// Four mechs for twenty-four bots, so the mapping has to be deterministic (a matchup always
// looks the same, same as it always plays the same) AND has to guarantee the two fighters
// never load as the same model - two identical silhouettes in one bout is unreadable.
const MECHS = ['george', 'stan', 'leela', 'mike'];
const MECH_BY_WEAPON = {
  vspinner: 'george', hspinner: 'stan', flipper: 'leela',
  crusher: 'mike', hammer: 'george', control: 'stan',
};

// Which clip that weapon swings. The packs' clip names are fixed; this is the join between
// scraped weapon classes and the animation set we actually have.
const ATTACK_CLIP = {
  vspinner: 'Punch', hspinner: 'SwordSlash', flipper: 'Kick',
  crusher: 'Punch', hammer: 'SwordSlash', control: 'Kick',
};

// ---------------------------------------------------------------- procedural textures

function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');

  g.fillStyle = '#20242c'; g.fillRect(0, 0, 1024, 1024);

  // steel plate seams
  g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    const p = i * 128;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 1024); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(1024, p); g.stroke();
  }
  // plate bolts
  g.fillStyle = 'rgba(255,255,255,0.10)';
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
    for (const [dx, dy] of [[18, 18], [110, 18], [18, 110], [110, 110]]) {
      g.beginPath(); g.arc(x * 128 + dx, y * 128 + dy, 3.4, 0, TAU); g.fill();
    }
  }
  // noise / grime
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * 1024, y = Math.random() * 1024;
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.22})`;
    g.fillRect(x, y, 1 + Math.random() * 5, 1 + Math.random() * 5);
  }
  // hazard chevrons around the rim
  const R = 512;
  g.save(); g.translate(R, R);
  for (let i = 0; i < 48; i++) {
    g.rotate(TAU / 48);
    g.fillStyle = i % 2 ? '#f5b942' : '#15181e';
    g.beginPath();
    g.moveTo(430, -30); g.lineTo(500, -30); g.lineTo(500, 30); g.lineTo(430, 30);
    g.closePath(); g.fill();
  }
  // centre mark
  g.rotate(-TAU / 48 * 48);
  g.strokeStyle = 'rgba(245,185,66,0.35)'; g.lineWidth = 8;
  g.beginPath(); g.arc(0, 0, 150, 0, TAU); g.stroke();
  g.globalAlpha = 0.20;
  g.fillStyle = '#f5b942';
  for (let i = 0; i < 6; i++) {
    g.rotate(TAU / 6);
    g.beginPath();
    g.moveTo(0, -140); g.lineTo(52, -58); g.lineTo(0, -88); g.lineTo(-52, -58);
    g.closePath(); g.fill();
  }
  g.restore();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function sparkSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,214,140,0.95)');
  grad.addColorStop(0.6, 'rgba(255,138,40,0.35)');
  grad.addColorStop(1.0, 'rgba(255,120,20,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function labelSprite(text, hex) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(6,8,12,0.72)';
  g.strokeStyle = hex; g.lineWidth = 4;
  const r = 20;
  g.beginPath();
  g.moveTo(r, 14); g.lineTo(512 - r, 14); g.quadraticCurveTo(512 - 6, 14, 512 - 6, 14 + r);
  g.lineTo(512 - 6, 114 - r); g.quadraticCurveTo(512 - 6, 114, 512 - r, 114);
  g.lineTo(r, 114); g.quadraticCurveTo(6, 114, 6, 114 - r);
  g.lineTo(6, 14 + r); g.quadraticCurveTo(6, 14, r, 14);
  g.closePath(); g.fill(); g.stroke();

  g.fillStyle = '#fff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 58;
  g.font = `700 ${size}px ui-monospace, Menlo, monospace`;
  while (g.measureText(text).width > 452 && size > 22) {
    size -= 3;
    g.font = `700 ${size}px ui-monospace, Menlo, monospace`;
  }
  g.fillText(text, 256, 66);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(1.5, 0.375, 1);
  s.renderOrder = 20;
  return s;
}

// ---------------------------------------------------------------- weapons

const STEEL = () => new THREE.MeshStandardMaterial({ color: 0x9aa3b0, metalness: 0.95, roughness: 0.28 });

// A weapon rig: { group, update(dt, engaged), strike(), kind }. Spinners run permanently;
// the contact weapons animate only on the exchange they land.
//
// Exported so qa/qa.cjs can build all five rigs headlessly. The scraped season currently
// only contains vertical spinners, horizontal spinners and one hammer, so flipper and
// crusher would otherwise ship completely unexercised and fall over the first time a
// re-scrape at the venue turns one up.
export function buildWeapon(kind, accent) {
  const g = new THREE.Group();
  const steel = STEEL();
  const hot = new THREE.MeshStandardMaterial({
    color: accent, metalness: 0.6, roughness: 0.35,
    emissive: accent, emissiveIntensity: 0.75,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.85, roughness: 0.5 });

  let spinner = null, arm = null;

  if (kind === 'vspinner') {
    // drum: axis across the body, teeth on the barrel
    spinner = new THREE.Group();
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.72, 26), steel);
    drum.rotation.z = Math.PI / 2;
    spinner.add(drum);
    for (let i = 0; i < 3; i++) {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.1, 0.13), hot);
      tooth.rotation.x = (i / 3) * TAU;
      tooth.position.set(0, Math.cos((i / 3) * TAU) * 0.24, Math.sin((i / 3) * TAU) * 0.24);
      spinner.add(tooth);
    }
    spinner.position.set(0, 0.46, 0.5);
    g.add(spinner);
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.18, 0.52), dark);
    mount.position.set(0, 0.42, 0.2);
    g.add(mount);

  } else if (kind === 'hspinner') {
    // undercutter: long bar sweeping flat, close to the floor
    spinner = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.09, 0.2), steel);
    spinner.add(bar);
    for (const s of [-1, 1]) {
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.15, 0.3), hot);
      tip.position.set(s * 0.86, 0, 0);
      spinner.add(tip);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.16, 20), dark);
    spinner.add(hub);
    spinner.position.set(0, 0.34, 0.44);
    g.add(spinner);

  } else if (kind === 'flipper') {
    // hinged wedge that throws upward
    arm = new THREE.Group();
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(1.0, 0); shape.lineTo(0, 0.34); shape.closePath();
    const wedge = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: 0.95, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 }),
      steel);
    wedge.rotation.y = Math.PI / 2;
    wedge.position.set(0.47, 0, 0);
    arm.add(wedge);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.05, 0.1), hot);
    lip.position.set(0, 0.01, 0.98);
    arm.add(lip);
    arm.position.set(0, 0.06, 0.4);
    g.add(arm);

  } else if (kind === 'crusher') {
    // beak. upper jaw hinges down onto a fixed lower jaw
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 1.0), dark);
    lower.position.set(0, 0.42, 0.55);
    g.add(lower);
    arm = new THREE.Group();
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.13, 0.94), steel);
    upper.position.set(0, 0, 0.47);
    arm.add(upper);
    const fang = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 12), hot);
    fang.rotation.x = Math.PI;
    fang.position.set(0, -0.16, 0.9);
    arm.add(fang);
    arm.position.set(0, 0.72, 0.1);
    g.add(arm);

  } else {
    // hammer / saw: shaft + head on an overhead swing, cocked back at rest
    arm = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.8, 12), dark);
    shaft.position.set(0, -0.4, 0);
    arm.add(shaft);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.38), steel);
    head.position.set(0, -0.8, 0.04);
    arm.add(head);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.1), hot);
    edge.position.set(0, -0.8, 0.24);
    arm.add(edge);
    const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 14), dark);
    pivot.rotation.z = Math.PI / 2;
    arm.add(pivot);
    arm.position.set(0, 1.25, 0.22);
    arm.rotation.x = -2.2;
    g.add(arm);
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });

  let strikeT = -1;
  return {
    group: g, kind,
    strike() { strikeT = 0; },
    update(dt, engaged) {
      if (spinner) {
        // spinners never stop; they wind down slightly between exchanges so the whine has
        // something to track
        spinner.rotation[kind === 'hspinner' ? 'y' : 'x'] += dt * (engaged ? 46 : 26);
      }
      if (arm) {
        if (strikeT >= 0) {
          strikeT += dt * 3.4;
          const k = Math.min(1, strikeT);
          // fast out, slow back
          const swing = k < 0.32 ? (k / 0.32) : 1 - (k - 0.32) / 0.68;
          if (kind === 'flipper') arm.rotation.x = -swing * 1.15;
          else if (kind === 'crusher') arm.rotation.x = swing * 0.62;
          else arm.rotation.x = -2.2 + swing * 3.1;
          if (k >= 1) strikeT = -1;
        }
      }
    },
  };
}

// ---------------------------------------------------------------- particles

class Sparks {
  constructor(scene, max = 700) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.head = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo = geo;
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.13, map: sparkSprite(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -999;
  }
  burst(p, n, power = 1, tint = null) {
    for (let i = 0; i < n; i++) {
      const k = this.head; this.head = (this.head + 1) % this.max;
      this.pos[k * 3] = p.x; this.pos[k * 3 + 1] = p.y; this.pos[k * 3 + 2] = p.z;
      const a = Math.random() * TAU, e = Math.random() * 1.3;
      const s = (1.6 + Math.random() * 4.4) * power;
      this.vel[k * 3] = Math.cos(a) * Math.cos(e) * s;
      this.vel[k * 3 + 1] = (0.4 + Math.sin(e)) * s * 0.85;
      this.vel[k * 3 + 2] = Math.sin(a) * Math.cos(e) * s;
      this.life[k] = 0.4 + Math.random() * 0.55;
      const c = tint || (Math.random() < 0.28 ? 0xfff0c0 : 0xffa32a);
      this.col[k * 3] = ((c >> 16) & 255) / 255;
      this.col[k * 3 + 1] = ((c >> 8) & 255) / 255;
      this.col[k * 3 + 2] = (c & 255) / 255;
    }
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      this.vel[j + 1] -= 13 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < 0.04) { this.pos[j + 1] = 0.04; this.vel[j + 1] *= -0.35; this.vel[j] *= 0.6; this.vel[j + 2] *= 0.6; }
      if (this.life[i] <= 0) this.pos[j + 1] = -999;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- the arena

export class Arena3D {
  constructor(canvas) {
    this.cv = canvas;
    this.ready = false;
    this.bout = null;
    this.mechs = {};          // name -> { scene, clips }
    this.t = 0;
    this.shake = 0;
    this.orbit = 0.6;
    this.camPunch = 0;
    this.timeScale = 1;

    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    this.renderer = r;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.028);

    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 120);
    this.camera.position.set(0, 4.4, 9);

    this._buildArena();
    this.sparks = new Sparks(this.scene);

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    this.last = performance.now();
    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------ scene build

  _buildArena() {
    const S = this.scene;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    S.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    // low: the room env is there to give the metal something to reflect, not to light the
    // scene. Turn it up and every flat metal surface catches the env's big white area light
    // and blows out into a featureless slab.
    S.environmentIntensity = 0.3;

    // Kept deliberately tight. A real BattleBox is enormous relative to a 250 lb robot, and
    // reproducing that ratio puts two ants in the middle of a car park.
    const R = 6.6;

    // floor
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R, 64),
      new THREE.MeshStandardMaterial({ map: floorTexture(), metalness: 0.62, roughness: 0.62 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    S.add(floor);

    // deck the box sits on. Without it the arena floats on a disc in a void and the fog has
    // nothing to grade into.
    const deck = new THREE.Mesh(
      new THREE.RingGeometry(R - 0.02, 15, 48),
      new THREE.MeshStandardMaterial({ color: 0x0e1117, metalness: 0.2, roughness: 0.95 }));
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = -0.03;
    S.add(deck);

    // slow-turning centre disc, flush with the floor - stops the middle reading as flat paint
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 2.2, 0.06, 48),
      new THREE.MeshStandardMaterial({ color: 0x272c34, metalness: 0.35, roughness: 0.82 }));
    disc.position.y = 0.02;
    disc.receiveShadow = true;
    S.add(disc);
    for (let i = 0; i < 8; i++) {
      const tooth = new THREE.Mesh(
        new THREE.BoxGeometry(0.44, 0.08, 0.14),
        new THREE.MeshStandardMaterial({ color: 0xf5b942, metalness: 0.5, roughness: 0.55, emissive: 0x2a1c00 }));
      const a = (i / 8) * TAU;
      tooth.position.set(Math.cos(a) * 1.78, 0.05, Math.sin(a) * 1.78);
      tooth.rotation.y = -a;
      disc.add(tooth);
    }
    this.disc = disc;

    // octagonal cage: lexan panels in a steel frame
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x9fd8ff, metalness: 0, roughness: 0.06,
      transparent: true, opacity: 0.14, side: THREE.DoubleSide,
    });
    const frame = new THREE.MeshStandardMaterial({ color: 0x333a45, metalness: 0.9, roughness: 0.42 });
    const N = 8, wallH = 2.9;
    const side = 2 * R * Math.tan(Math.PI / N);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + Math.PI / N;
      const x = Math.cos(a) * R, z = Math.sin(a) * R;

      const panel = new THREE.Mesh(new THREE.PlaneGeometry(side, wallH), glass);
      panel.position.set(x, wallH / 2, z);
      panel.lookAt(0, wallH / 2, 0);
      S.add(panel);

      const post = new THREE.Mesh(new THREE.BoxGeometry(0.26, wallH + 0.5, 0.26), frame);
      const pa = (i / N) * TAU;
      post.position.set(Math.cos(pa) * (R / Math.cos(Math.PI / N)), (wallH + 0.5) / 2, Math.sin(pa) * (R / Math.cos(Math.PI / N)));
      post.castShadow = true;
      S.add(post);

      const rail = new THREE.Mesh(new THREE.BoxGeometry(side, 0.2, 0.3), frame);
      rail.position.set(x, wallH + 0.14, z);
      rail.lookAt(new THREE.Vector3(0, wallH + 0.14, 0));
      rail.rotateY(Math.PI / 2);
      S.add(rail);

      const kick = new THREE.Mesh(new THREE.BoxGeometry(side, 0.42, 0.22), frame);
      kick.position.set(x, 0.21, z);
      kick.lookAt(new THREE.Vector3(0, 0.21, 0));
      kick.rotateY(Math.PI / 2);
      kick.castShadow = true;
      S.add(kick);
    }

    // crowd: warm pinpricks out past the cage, plus a dark bowl so the fog has something
    // to sit against instead of empty black
    const bowl = new THREE.Mesh(
      new THREE.CylinderGeometry(16, 12, 11, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x0b0d13, side: THREE.BackSide, metalness: 0.1, roughness: 1 }));
    bowl.position.y = 4;
    S.add(bowl);

    const cg = new THREE.BufferGeometry();
    const cp = [];
    for (let i = 0; i < 900; i++) {
      const a = Math.random() * TAU, rr = 8.6 + Math.random() * 4.4;
      cp.push(Math.cos(a) * rr, 1.4 + Math.random() * 4.6, Math.sin(a) * rr);
    }
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
    S.add(new THREE.Points(cg, new THREE.PointsMaterial({
      size: 0.1, color: 0xffcf8a, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })));

    // lighting rig
    S.add(new THREE.HemisphereLight(0x7fa6d8, 0x14161c, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(5, 10, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -9; key.shadow.camera.right = 9;
    key.shadow.camera.top = 9; key.shadow.camera.bottom = -9;
    key.shadow.bias = -0.0016;
    S.add(key);

    // cold backlight so a robot never disappears into the far wall
    const rim = new THREE.DirectionalLight(0x9ec8ff, 1.1);
    rim.position.set(-6, 4, -7);
    S.add(rim);

    for (const [x, z, c, i] of [[-5, -5, 0xfff0d0, 90], [5, -5, 0xd8e8ff, 75], [0, 6, 0xfff0d0, 80]]) {
      const sp = new THREE.SpotLight(c, i, 24, 0.8, 0.45, 1.6);
      sp.position.set(x, 8, z);
      sp.target.position.set(0, 0, 0);
      S.add(sp); S.add(sp.target);
    }

    // corner accents - punched on impact
    this.lightA = new THREE.PointLight(CORNER.a, 18, 13, 2);
    this.lightB = new THREE.PointLight(CORNER.b, 18, 13, 2);
    this.lightA.position.set(-5, 2.2, 0);
    this.lightB.position.set(5, 2.2, 0);
    S.add(this.lightA, this.lightB);

    this.flashLight = new THREE.PointLight(0xffc061, 0, 12, 2);
    this.flashLight.position.set(0, 1.6, 0);
    S.add(this.flashLight);

    this.debris = [];
    const dm = new THREE.MeshStandardMaterial({ color: 0x8d94a2, metalness: 0.9, roughness: 0.4 });
    for (let i = 0; i < 26; i++) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.17), dm);
      d.visible = false; d.castShadow = true;
      d.userData = { v: new THREE.Vector3(), w: new THREE.Vector3(), life: 0 };
      S.add(d); this.debris.push(d);
    }
    this.debrisHead = 0;
  }

  // ------------------------------------------------------------ asset load

  async load(onProgress) {
    const loader = new GLTFLoader();
    let done = 0;
    // One retry per model. Four concurrent multi-megabyte GETs against a small static server
    // occasionally get one aborted, and losing a mech on the night means losing the demo.
    const fetchGlb = (url, tries = 2) => new Promise((res, rej) => {
      loader.load(url, res, undefined, (err) => {
        if (tries > 1) setTimeout(() => fetchGlb(url, tries - 1).then(res, rej), 350);
        else rej(err);
      });
    });
    await Promise.all(MECHS.map((name) => fetchGlb(`assets/models/${name}.glb`)
      .then((g) => {
        const root = g.scene;
        // the pack ships KHR_materials_unlit, which three resolves to MeshBasicMaterial -
        // flat, ignores every light in the rig. Re-materialise onto Standard, keep the
        // baked colour atlas as the albedo map, and let the arena lighting do the work.
        root.traverse((o) => {
          if (!o.isMesh && !o.isSkinnedMesh) return;
          const src = Array.isArray(o.material) ? o.material[0] : o.material;
          o.material = new THREE.MeshStandardMaterial({
            map: src.map || null,
            color: src.map ? 0xffffff : (src.color || new THREE.Color(0xaaaaaa)),
            metalness: 0.55, roughness: 0.46,
            envMapIntensity: 1.0,
            side: THREE.FrontSide,
          });
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = false;
        });
        this.mechs[name] = { scene: root, clips: g.animations };
        done++;
        if (onProgress) onProgress(done / MECHS.length);
      })));
    this.ready = true;
  }

  // ------------------------------------------------------------ fighters

  _mechFor(bot, taken) {
    let name = MECH_BY_WEAPON[bot.weapon] || MECHS[0];
    if (taken && name === taken) name = MECHS[(MECHS.indexOf(name) + 1) % MECHS.length];
    return name;
  }

  _makeFighter(bot, cornerKey, mechName) {
    const src = this.mechs[mechName];
    const obj = skinnedClone(src.scene);
    const accent = CORNER[cornerKey];

    // normalise height - the pack's four mechs are not the same scale, and a fight where
    // one robot is half the other's size reads as a bug rather than as a weight class
    const box = new THREE.Box3().setFromObject(obj);
    const h = Math.max(0.001, box.max.y - box.min.y);
    const s = 2.1 / h;
    obj.scale.setScalar(s);
    obj.position.y = -box.min.y * s;

    const root = new THREE.Group();
    root.add(obj);
    this.scene.add(root);

    const mixer = new THREE.AnimationMixer(obj);
    const clips = {};
    for (const c of src.clips) clips[c.name] = c;

    // underglow: reads the corner instantly even when the camera is behind a robot.
    // Flat on the floor, not a billboard - a camera-facing sprite down here stands up like
    // a coin on edge as soon as the camera drops toward the deck.
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.0, 3.0),
      new THREE.MeshBasicMaterial({
        map: sparkSprite(), color: accent, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.55,
      }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.04;
    root.add(glow);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.14, 40),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    root.add(ring);

    const plate = labelSprite(bot.name.toUpperCase(), '#' + accent.toString(16).padStart(6, '0'));
    plate.position.y = 2.45;
    plate.scale.set(1.05, 0.2625, 1);
    root.add(plate);

    // Weapon. Everything hull-mounts on the fighter root, never on an arm bone: the four
    // mechs have different armature scales, so a bone-parented weapon comes out a different
    // size on each of them, and Skorpios' hammer arrived as a three-metre pole. It is also
    // the more accurate read - a real hammer bot articulates its weapon off the chassis.
    const wkind = MECH_BY_WEAPON[bot.weapon] ? bot.weapon : 'control';
    const wep = buildWeapon(wkind, accent);
    root.add(wep.group);

    return {
      bot, corner: cornerKey, accent, root, obj, mixer, clips, wep, glow, ring, plate,
      hp: 100, action: null, dead: false, hurt: 0, mech: mechName,
    };
  }

  _play(f, name, { loop = true, fade = 0.18, once = false } = {}) {
    const clip = f.clips[name];
    if (!clip) return null;
    const act = f.mixer.clipAction(clip);
    if (f.action === act && !once) return act;
    if (once) {
      // hand the whole body over to the swing - blending a punch 50/50 against a run cycle
      // reads as a shrug rather than as a hit
      if (f.action) { f.action.fadeOut(0.1); f.action = null; }
      act.reset();
      act.setLoop(THREE.LoopOnce, 1);
      act.clampWhenFinished = false;
      act.setEffectiveWeight(1);
      act.timeScale = 1.3;
      act.fadeIn(0.05).play();
      return act;
    }
    if (f.action) f.action.fadeOut(fade);
    act.reset();
    act.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    act.clampWhenFinished = !loop;
    act.fadeIn(fade).play();
    f.action = act;
    return act;
  }

  // ------------------------------------------------------------ playback

  play(bout, { onEvent, onDone, onTick } = {}) {
    this.stop();

    const mechA = this._mechFor(bout.a, null);
    const mechB = this._mechFor(bout.b, mechA);
    this.A = this._makeFighter(bout.a, 'a', mechA);
    this.B = this._makeFighter(bout.b, 'b', mechB);
    this.byId = { [bout.a.id]: this.A, [bout.b.id]: this.B };

    this.bout = bout;
    this.queue = bout.events.filter((e) => e.type !== 'start').slice();
    this.onEvent = onEvent; this.onDone = onDone; this.onTick = onTick;

    this.phase = 'closing';
    this.pt = 0;
    this.ringAng = Math.random() * TAU;
    this.sep = 4.8;
    this.hitPoint = new THREE.Vector3(0, 1.0, 0);
    this.clock = 0;
    this.finished = false;
    this.timeScale = 1;
    this.orbit = this.ringAng + Math.PI / 2;

    // roughly twenty seconds of fight regardless of how many exchanges the timeline holds
    const n = Math.max(1, this.queue.length);
    this.cycleDur = clamp(20 / n, 0.95, 2.3);

    this._place(1);
    this._play(this.A, 'Idle'); this._play(this.B, 'Idle');
  }

  stop() {
    for (const f of [this.A, this.B]) {
      if (!f) continue;
      f.mixer.stopAllAction();
      this.scene.remove(f.root);
      f.root.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) { o.geometry?.dispose?.(); }
        if (o.isSprite) { o.material.map?.dispose?.(); o.material.dispose(); }
      });
    }
    this.A = this.B = null;
    this.bout = null;
    this.queue = [];
    this.phase = null;
  }

  // place both fighters on the current engagement axis at the current separation
  _place(k) {
    if (!this.A) return;
    const c = Math.cos(this.ringAng), s = Math.sin(this.ringAng);
    const cx = Math.cos(this.ringAng * 0.7) * 1.5;
    const cz = Math.sin(this.ringAng * 0.7) * 1.5;
    const half = this.sep / 2;
    const ax = cx - c * half, az = cz - s * half;
    const bx = cx + c * half, bz = cz + s * half;

    this.A.root.position.lerp(new THREE.Vector3(ax, 0, az), k);
    this.B.root.position.lerp(new THREE.Vector3(bx, 0, bz), k);
    if (!this.A.dead) this.A.root.lookAt(this.B.root.position.x, 0, this.B.root.position.z);
    if (!this.B.dead) this.B.root.lookAt(this.A.root.position.x, 0, this.A.root.position.z);

    this.hitPoint.set((ax + bx) / 2, 1.0, (az + bz) / 2);
  }

  _spawnDebris(p, n) {
    for (let i = 0; i < n; i++) {
      const d = this.debris[this.debrisHead];
      this.debrisHead = (this.debrisHead + 1) % this.debris.length;
      d.visible = true;
      d.position.copy(p);
      const a = Math.random() * TAU;
      d.userData.v.set(Math.cos(a) * (1 + Math.random() * 4), 2 + Math.random() * 5, Math.sin(a) * (1 + Math.random() * 4));
      d.userData.w.set(Math.random() * 12, Math.random() * 12, Math.random() * 12);
      d.userData.life = 1.6 + Math.random();
    }
  }

  _impact(ev) {
    const att = ev.actor ? this.byId[ev.actor] : null;
    const def = ev.target ? this.byId[ev.target] : null;
    const big = ev.type === 'bighit' || ev.type === 'oota' || ev.type === 'ko';

    // a judges' decision is not a blow - firing sparks off it would be the renderer
    // inventing an exchange the timeline never had
    if (ev.type === 'decision') { if (this.onEvent) this.onEvent(ev); return; }

    if (att && !att.dead) {
      this._play(att, ATTACK_CLIP[att.bot.weapon] || 'Punch', { once: true });
      att.wep.strike();
    }

    if (ev.type === 'miss') {
      this.sparks.burst(this.hitPoint, 6, 0.5, 0x9fd8ff);
      if (this.onEvent) this.onEvent(ev);
      return;
    }

    if (def) {
      def.hp = ev.hpA !== undefined
        ? (def.bot.id === this.bout.a.id ? ev.hpA : ev.hpB)
        : def.hp;
      def.hurt = 0.4;
      if (!def.dead) this._play(def, Math.random() < 0.5 ? 'HitRecieve_1' : 'HitRecieve_2', { once: true });
    }

    const power = big ? 1.9 : 1;
    this.sparks.burst(this.hitPoint, big ? 150 : 55, power);
    this._spawnDebris(this.hitPoint, big ? 7 : 3);
    this.shake = Math.min(1.1, this.shake + (big ? 0.85 : 0.35));
    this.camPunch = big ? 1 : 0.45;
    this.flashLight.position.copy(this.hitPoint);
    this.flashLight.intensity = big ? 90 : 38;
    if (big) this.timeScale = 0.3;             // hit-stop, released in _loop

    if (ev.type === 'oota' && def) def.dead = true;

    if (this.onEvent) this.onEvent(ev);
  }

  _finish() {
    this.finished = true;
    const win = this.byId[this.bout.winner.id];
    const lose = this.byId[this.bout.loser.id];
    const ko = this.bout.method === 'KO';
    lose.dead = ko;
    // a bot that lost on points is still driving, so it does not get to fall over
    this._play(lose, ko ? 'Death' : 'No', { loop: !ko, fade: 0.12 });
    this._play(win, 'Dance', { fade: 0.25 });
    win.wep.strike();
    if (ko) {
      this.sparks.burst(lose.root.position.clone().setY(0.9), 90, 1.5);
      this._spawnDebris(lose.root.position.clone().setY(0.8), 8);
      this.shake = 1.0;
    }
    if (this.onDone) this.onDone(this.bout);
  }

  // ------------------------------------------------------------ frame

  _loop(now) {
    this.raf = requestAnimationFrame(this._loop);
    const dtRaw = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.timeScale = lerp(this.timeScale, 1, dtRaw * 6);
    const dt = dtRaw * this.timeScale;
    this.t += dt;

    if (this.disc) this.disc.rotation.y += dt * 0.22;

    if (this.A && this.phase) this._step(dt);
    else this._attract(dt);

    // debris
    for (const d of this.debris) {
      if (!d.visible) continue;
      const u = d.userData;
      u.life -= dt;
      u.v.y -= 15 * dt;
      d.position.addScaledVector(u.v, dt);
      d.rotation.x += u.w.x * dt; d.rotation.y += u.w.y * dt; d.rotation.z += u.w.z * dt;
      if (d.position.y < 0.05) { d.position.y = 0.05; u.v.y *= -0.32; u.v.x *= 0.7; u.v.z *= 0.7; }
      if (u.life <= 0) d.visible = false;
    }

    this.sparks.update(dt);
    this.flashLight.intensity = lerp(this.flashLight.intensity, 0, dtRaw * 7);
    this.shake = Math.max(0, this.shake - dtRaw * 2.1);
    this.camPunch = Math.max(0, this.camPunch - dtRaw * 3.4);

    this._camera(dtRaw);
    this.renderer.render(this.scene, this.camera);
  }

  _attract(dt) {
    this.orbit += dt * 0.16;
  }

  _step(dt) {
    for (const f of [this.A, this.B]) {
      f.mixer.update(dt);
      f.wep.update(dt, this.phase === 'closing' || this.phase === 'impact');
      f.hurt = Math.max(0, f.hurt - dt * 2);
      const pulse = 0.55 + Math.sin(this.t * 4 + (f.corner === 'a' ? 0 : 2)) * 0.08 + f.hurt * 0.6;
      f.ring.material.opacity = pulse * 0.7;
      f.glow.material.opacity = 0.45 + f.hurt * 0.7;
      f.plate.material.opacity = this.finished ? Math.max(0, f.plate.material.opacity - dt) : 1;
    }

    this.pt += dt;

    if (this.phase === 'closing') {
      const k = clamp(this.pt / (this.cycleDur * 0.58), 0, 1);
      this.sep = lerp(4.4, 1.7, k * k * (3 - 2 * k));
      this._place(0.35);
      if (k > 0.06) { this._play(this.A, 'Run'); this._play(this.B, 'Run'); }
      if (k >= 1) {
        this.phase = 'impact'; this.pt = 0;
        const ev = this.queue.shift();
        if (ev) this._impact(ev);
      }
    } else if (this.phase === 'impact') {
      this.sep = lerp(this.sep, 1.55, dt * 5);
      this._place(0.5);
      if (this.pt > 0.42) {
        this.pt = 0;
        if (this.queue.length === 0) { this.phase = 'finish'; this._finish(); }
        else { this.phase = 'reset'; }
      }
    } else if (this.phase === 'reset') {
      const k = clamp(this.pt / (this.cycleDur * 0.42), 0, 1);
      this.sep = lerp(1.7, 4.4, k);
      this.ringAng += dt * 0.55;
      this._place(0.3);
      if (k > 0.25) { this._play(this.A, 'Walk'); this._play(this.B, 'Walk'); }
      if (k >= 1) { this.phase = 'closing'; this.pt = 0; }
    } else if (this.phase === 'finish') {
      this.ringAng += dt * 0.12;
    }

    // clock: the bout carries real seconds, so scale the wall clock onto it
    if (this.onTick) {
      const total = Math.max(1, this.bout.seconds);
      const prog = this.finished ? 1 : clamp(this.clock / (this.cycleDur * Math.max(1, this.bout.events.length - 1)), 0, 1);
      this.clock += dt;
      this.onTick({
        sec: Math.round(prog * total),
        hpA: this.byId[this.bout.a.id].hp,
        hpB: this.byId[this.bout.b.id].hp,
      });
    }
  }

  _camera(dt) {
    const look = new THREE.Vector3(0, 1.1, 0);
    let radius = 8.4, height = 3.8;

    if (this.A && this.B) {
      look.copy(this.A.root.position).add(this.B.root.position).multiplyScalar(0.5);
      look.y = 1.15;
      const spread = this.A.root.position.distanceTo(this.B.root.position);
      // ringside, not the blimp shot. Two 2m robots have to fill the frame or the whole
      // point of going 3D is lost.
      radius = 3.9 + spread * 0.52;
      height = 1.9 + spread * 0.2;
      // ride just off the engagement axis so both robots stay separated on screen
      this.orbit = lerp(this.orbit, this.ringAng + Math.PI / 2 + 0.45, dt * 1.6);
      if (this.finished) { radius = lerp(radius, 4.2, 0.6); height = 1.9; }
    } else {
      this.orbit += dt * 0.05;
    }

    radius -= this.camPunch * 0.6;
    const sx = (Math.random() - 0.5) * this.shake * 0.55;
    const sy = (Math.random() - 0.5) * this.shake * 0.4;

    const tx = look.x + Math.cos(this.orbit) * radius;
    const tz = look.z + Math.sin(this.orbit) * radius;
    this.camera.position.lerp(new THREE.Vector3(tx + sx, height + sy, tz), Math.min(1, dt * 3.4));
    this.camera.lookAt(look.x + sx * 0.4, look.y + sy * 0.4, look.z);

    this.lightA.intensity = lerp(this.lightA.intensity, this.A && this.A.hurt > 0.05 ? 90 : 26, dt * 6);
    this.lightB.intensity = lerp(this.lightB.intensity, this.B && this.B.hurt > 0.05 ? 90 : 26, dt * 6);
  }

  _resize() {
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(320, r.width), h = Math.max(240, r.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }
}
