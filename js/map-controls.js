import * as THREE from 'three';

// Map camera: drag to pan (glides on release), wheel or pinch to zoom at the cursor.
// Trackpads pan with two fingers and zoom with a pinch, the way map apps do.
// Every gesture moves `goal`; the camera (`view`) eases towards it, so motion stays soft.

const FOLLOW_RATE = 9; // how fast the view follows a drag, pinch or trackpad scroll, 1/s
const ZOOM_RATE = 6; // how fast the view catches up with a mouse-wheel zoom, 1/s
const GLIDE_RATE = 2.2; // how fast a released drag comes to rest, 1/s
const MOUSE_WHEEL_SPEED = 0.0014;
const PINCH_WHEEL_SPEED = 0.01;
const TRACKPAD_IDLE_MS = 400;

export function createMapControls({ camera, dom, place, minDist, maxDist, bounds, onStart }) {
  const view = { target: new THREE.Vector3(), dist: 1 };
  const goal = { target: new THREE.Vector3(), dist: 1 };
  let targetRate = FOLLOW_RATE;
  let distRate = FOLLOW_RATE;

  function follow(rate) {
    targetRate = rate;
    distRate = rate;
  }

  const scratch = camera.clone();
  const raycaster = new THREE.Raycaster();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();

  function clampState(s) {
    const half = bounds();
    s.target.x = THREE.MathUtils.clamp(s.target.x, -half, half);
    s.target.z = THREE.MathUtils.clamp(s.target.z, -half, half);
    s.target.y = 0;
    s.dist = THREE.MathUtils.clamp(s.dist, minDist, maxDist());
  }

  // ground point under a client-space position, seen from the camera at state `s`
  function groundAt(s, clientX, clientY, out) {
    scratch.copy(camera);
    place(scratch, s.target, s.dist);
    const rect = dom.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, scratch);
    return raycaster.ray.intersectPlane(ground, out);
  }

  // scale the distance of `s` while the ground under (clientX, clientY) stays put
  const before = new THREE.Vector3();
  function zoomAt(s, factor, clientX, clientY) {
    const a = groundAt(s, clientX, clientY, before);
    s.dist = THREE.MathUtils.clamp(s.dist * factor, minDist, maxDist());
    const b = a && groundAt(s, clientX, clientY, hit);
    if (a && b) s.target.add(a.sub(b));
    clampState(s);
  }

  // move `s` so the ground under `from` ends up under `to`
  const panDelta = new THREE.Vector3();
  function panBetween(s, fromX, fromY, toX, toY) {
    const a = groundAt(s, fromX, fromY, before);
    const b = a && groundAt(s, toX, toY, hit);
    if (!a || !b) return null;
    panDelta.copy(a).sub(b);
    return panDelta;
  }

  function moveGoal(delta) {
    goal.target.add(delta);
    clampState(goal);
  }

  // ---------- pointers: one drags, two pinch ----------

  const pointers = new Map();
  let samples = []; // recent drag moves for the release glide: { t, dx, dz }

  function midpoint() {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  let pinch = null;

  dom.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    onStart();
    // grab the map where it is now: stop a glide still running
    if (targetRate === GLIDE_RATE) goal.target.copy(view.target);
    follow(FOLLOW_RATE);
    samples = [];
    pinch = pointers.size === 2 ? midpoint() : null;
  });

  dom.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const prev = { x: p.x, y: p.y };
    p.x = e.clientX;
    p.y = e.clientY;

    if (pointers.size === 1) {
      const d = panBetween(goal, prev.x, prev.y, p.x, p.y);
      if (!d) return;
      moveGoal(d);
      const now = performance.now();
      samples.push({ t: now, dx: d.x, dz: d.z });
      samples = samples.filter((s) => now - s.t < 100);
    } else if (pointers.size === 2 && pinch) {
      const next = midpoint();
      if (next.spread > 0) zoomAt(goal, pinch.spread / next.spread, pinch.x, pinch.y);
      const d = panBetween(goal, pinch.x, pinch.y, next.x, next.y);
      if (d) moveGoal(d);
      pinch = next;
    }
  });

  function release(e) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 1) {
      // lifting one finger of a pinch: carry on dragging with the other, no glide yet
      samples = [];
      pinch = null;
      return;
    }
    pinch = pointers.size === 2 ? midpoint() : null;
    if (pointers.size > 0) return;

    const now = performance.now();
    const recent = samples.filter((s) => now - s.t < 80);
    if (recent.length >= 2) {
      const span = Math.max(now - recent[0].t, 16) / 1000;
      const vx = recent.reduce((sum, s) => sum + s.dx, 0) / span;
      const vz = recent.reduce((sum, s) => sum + s.dz, 0) / span;
      // easing at GLIDE_RATE starts at the release speed and covers v / rate in total
      goal.target.x += vx / GLIDE_RATE;
      goal.target.z += vz / GLIDE_RATE;
      clampState(goal);
      targetRate = GLIDE_RATE;
    }
    samples = [];
  }
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);

  // ---------- wheel: mouse wheel zooms, trackpad scroll pans, trackpad pinch zooms ----------

  let trackpadUntil = 0;
  function isTrackpad(e) {
    const now = performance.now();
    const looksLikeTrackpad = e.deltaMode === 0 && (
      e.deltaX !== 0
      || !Number.isInteger(e.deltaY)
      || (e.wheelDeltaY && e.wheelDeltaY === -3 * e.deltaY && e.wheelDeltaY % 120 !== 0)
    );
    if (looksLikeTrackpad || now < trackpadUntil) {
      trackpadUntil = now + TRACKPAD_IDLE_MS;
      return true;
    }
    return false;
  }

  function onWheel(e) {
    e.preventDefault();
    onStart();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;

    if (e.ctrlKey) {
      // trackpad pinch (and ctrl + wheel)
      zoomAt(goal, Math.exp(dy * PINCH_WHEEL_SPEED), e.clientX, e.clientY);
      follow(FOLLOW_RATE);
    } else if (isTrackpad(e)) {
      // two-finger scroll: the OS already adds momentum, so no glide of our own
      const rect = dom.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const d = panBetween(goal, cx + dx, cy + dy, cx, cy);
      if (d) moveGoal(d);
      follow(FOLLOW_RATE);
    } else {
      zoomAt(goal, Math.exp(dy * MOUSE_WHEEL_SPEED), e.clientX, e.clientY);
      follow(ZOOM_RATE);
    }
  }
  // markers and labels sit above the canvas: let the wheel over them steer the map too
  const wheelTargets = [dom, document.getElementById('markers')];
  wheelTargets.forEach((el) => el && el.addEventListener('wheel', onWheel, { passive: false }));

  // Safari on macOS reports trackpad pinches as gesture events instead of ctrl + wheel
  let gestureScale = 1;
  const isTouchGesture = () => pointers.size > 0;
  document.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureScale = 1;
    if (!isTouchGesture()) onStart();
  });
  document.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (isTouchGesture()) return; // iOS: the pointer pinch above already handles it
    const factor = gestureScale / e.scale;
    gestureScale = e.scale;
    zoomAt(goal, factor, e.clientX, e.clientY);
    follow(FOLLOW_RATE);
  });
  document.addEventListener('gestureend', (e) => e.preventDefault());

  dom.style.touchAction = 'none';

  return {
    view,
    goal,

    // put the camera at a state immediately (animations drive this every frame)
    jump(target, dist) {
      view.target.copy(target);
      view.dist = dist;
      clampState(view);
      goal.target.copy(view.target);
      goal.dist = view.dist;
    },

    update(dt) {
      const kt = 1 - Math.exp(-targetRate * dt);
      const kd = 1 - Math.exp(-distRate * dt);
      view.target.lerp(goal.target, kt);
      view.dist += (goal.dist - view.dist) * kd;
      clampState(view);
      place(camera, view.target, view.dist);
    },
  };
}
