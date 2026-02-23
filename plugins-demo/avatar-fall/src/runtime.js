import Matter from "matter-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

const { Bodies, Body, Engine, World } = Matter;

const ABOUT_PATH = "/about";
const CONTROLLER_KEY = "__slAvatarFallController";
const APPLY_KEY = "__avatarFallApplyRoute";

const PHYSICS_MAX_DELTA_MS = 1000 / 30;
const FALLING_AVATAR_SIZE = 50;
const LAUNCH_SPEED_MIN = 7;
const LAUNCH_SPEED_MAX = 14;
const LAUNCH_ANGLE_JITTER = 0.16;
const AVATAR_RESTITUTION = 0.9;
const BOUNDS_RESTITUTION = 1;
const FADE_OUT_MS = 3000;

const SCREEN_WALL_THICKNESS = 140;
const WINDOW_SWEEP_PUSH = 0.9;
const WINDOW_SWEEP_MIN_SPEED = 8;
const WINDOW_SYNC_INTERVAL_MS = 60;

const appWindow = getCurrentWindow();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function normalizeRoute(route) {
  if (!route || route === "__INIT__") {
    return window.location && window.location.pathname ? window.location.pathname : "";
  }

  if (route === "__DISABLE__" || route === "__UNLOAD__") {
    return "";
  }

  return route;
}

function isPointInRect(position, rect, margin = 0) {
  return (
    position.x >= rect.x - margin &&
    position.x <= rect.x + rect.width + margin &&
    position.y >= rect.y - margin &&
    position.y <= rect.y + rect.height + margin
  );
}

function parsePosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (typeof value.x === "number" && typeof value.y === "number") {
    return { x: value.x, y: value.y };
  }
  if (value.payload && typeof value.payload === "object") {
    const payload = value.payload;
    if (typeof payload.x === "number" && typeof payload.y === "number") {
      return { x: payload.x, y: payload.y };
    }
  }
  return null;
}

function parseSize(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (typeof value.width === "number" && typeof value.height === "number") {
    return { width: value.width, height: value.height };
  }
  if (value.payload && typeof value.payload === "object") {
    const payload = value.payload;
    if (typeof payload.width === "number" && typeof payload.height === "number") {
      return { width: payload.width, height: payload.height };
    }
  }
  return null;
}

function createController() {
  const state = {
    currentRoute: "",
    engine: null,
    boundaryBodies: [],
    avatars: [],
    overlay: null,
    screenRect: { x: 0, y: 0, width: 1, height: 1 },
    windowRect: { x: 0, y: 0, width: 1, height: 1 },
    lastWindowRect: null,
    active: false,
    pending: false,
    fading: false,
    frameId: 0,
    lastFrame: 0,
    fadeTimer: 0,
    retryTimer: 0,
    resizeHandler: null,
    clickHandler: null,
    unlistenMoved: null,
    unlistenResized: null,
    tauriRectReady: false,
    tauriSyncInFlight: false,
    lastTauriSyncAt: 0,
  };

  function getScreenRect() {
    const x = typeof window.screen.availLeft === "number" ? window.screen.availLeft : 0;
    const y = typeof window.screen.availTop === "number" ? window.screen.availTop : 0;
    const width = Math.max(1, window.screen.availWidth || window.screen.width || window.innerWidth);
    const height = Math.max(
      1,
      window.screen.availHeight || window.screen.height || window.innerHeight,
    );
    return { x, y, width, height };
  }

  function getBrowserWindowRect() {
    const x =
      typeof window.screenX === "number"
        ? window.screenX
        : typeof window.screenLeft === "number"
          ? window.screenLeft
          : 0;
    const y =
      typeof window.screenY === "number"
        ? window.screenY
        : typeof window.screenTop === "number"
          ? window.screenTop
          : 0;
    const width = Math.max(1, window.outerWidth || window.innerWidth);
    const height = Math.max(1, window.outerHeight || window.innerHeight);
    return { x, y, width, height };
  }

  function syncRects() {
    state.screenRect = getScreenRect();
    if (!state.tauriRectReady) {
      state.windowRect = getBrowserWindowRect();
    }
    if (!state.lastWindowRect) {
      state.lastWindowRect = { ...state.windowRect };
    }
  }

  async function syncWindowRectFromTauri(force = false) {
    const now = performance.now();
    if (!force) {
      if (state.tauriSyncInFlight) return;
      if (now - state.lastTauriSyncAt < WINDOW_SYNC_INTERVAL_MS) return;
    }

    state.tauriSyncInFlight = true;
    state.lastTauriSyncAt = now;
    try {
      const [positionRaw, sizeRaw] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
      const position = parsePosition(positionRaw);
      const size = parseSize(sizeRaw);
      if (position && size) {
        state.windowRect = {
          x: position.x,
          y: position.y,
          width: Math.max(1, size.width),
          height: Math.max(1, size.height),
        };
        state.tauriRectReady = true;
      }
    } catch {
      state.tauriRectReady = false;
    } finally {
      state.tauriSyncInFlight = false;
    }
  }

  async function startWindowTracking() {
    if (!state.unlistenMoved) {
      try {
        state.unlistenMoved = await appWindow.onMoved((event) => {
          const position = parsePosition(event);
          if (!position) return;
          state.windowRect = { ...state.windowRect, x: position.x, y: position.y };
          state.tauriRectReady = true;
        });
      } catch {
        state.unlistenMoved = null;
      }
    }

    if (!state.unlistenResized) {
      try {
        state.unlistenResized = await appWindow.onResized((event) => {
          const size = parseSize(event);
          if (!size) return;
          state.windowRect = {
            ...state.windowRect,
            width: Math.max(1, size.width),
            height: Math.max(1, size.height),
          };
          state.tauriRectReady = true;
        });
      } catch {
        state.unlistenResized = null;
      }
    }

    await syncWindowRectFromTauri(true);
  }

  function stopWindowTracking() {
    if (state.unlistenMoved) {
      state.unlistenMoved();
      state.unlistenMoved = null;
    }
    if (state.unlistenResized) {
      state.unlistenResized();
      state.unlistenResized = null;
    }
    state.tauriRectReady = false;
    state.tauriSyncInFlight = false;
  }

  function ensureOverlay() {
    if (state.overlay && state.overlay.parentNode) {
      return;
    }

    const overlay = document.createElement("div");
    overlay.id = "avatar-fall-layer";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.overflow = "hidden";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "9997";
    overlay.style.opacity = "1";
    overlay.style.transition = `opacity ${FADE_OUT_MS}ms ease`;

    document.body.appendChild(overlay);
    state.overlay = overlay;
  }

  function syncOverlayBounds() {
    if (!state.overlay) return;
    state.overlay.style.left = "0px";
    state.overlay.style.top = "0px";
    state.overlay.style.width = `${Math.max(1, window.innerWidth)}px`;
    state.overlay.style.height = `${Math.max(1, window.innerHeight)}px`;
  }

  function stopPhysicsLoop() {
    if (state.frameId) {
      cancelAnimationFrame(state.frameId);
      state.frameId = 0;
    }
    state.lastFrame = 0;
  }

  function clearTimers() {
    if (state.fadeTimer) {
      clearTimeout(state.fadeTimer);
      state.fadeTimer = 0;
    }
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = 0;
    }
  }

  function detachListeners() {
    if (state.resizeHandler) {
      window.removeEventListener("resize", state.resizeHandler);
      state.resizeHandler = null;
    }
    if (state.clickHandler) {
      document.removeEventListener("click", state.clickHandler, true);
      state.clickHandler = null;
    }
    stopWindowTracking();
  }

  function destroyMatterWorld() {
    if (!state.engine) {
      state.boundaryBodies = [];
      return;
    }
    World.clear(state.engine.world, false);
    Engine.clear(state.engine);
    state.engine = null;
    state.boundaryBodies = [];
  }

  function removeOverlay() {
    if (state.overlay && state.overlay.parentNode) {
      state.overlay.parentNode.removeChild(state.overlay);
    }
    state.overlay = null;
  }

  function createScreenBounds() {
    if (!state.engine) return;
    if (state.boundaryBodies.length > 0) {
      World.remove(state.engine.world, state.boundaryBodies);
    }

    const { x, y, width, height } = state.screenRect;
    const wall = SCREEN_WALL_THICKNESS;

    const options = {
      isStatic: true,
      restitution: BOUNDS_RESTITUTION,
      friction: 0.35,
      frictionStatic: 0.8,
      render: { visible: false },
    };

    state.boundaryBodies = [
      Bodies.rectangle(x - wall / 2, y + height / 2, wall, height * 2, options),
      Bodies.rectangle(x + width + wall / 2, y + height / 2, wall, height * 2, options),
      Bodies.rectangle(x + width / 2, y - wall / 2, width * 2, wall, options),
      Bodies.rectangle(x + width / 2, y + height + wall / 2, width * 2, wall, options),
    ];

    World.add(state.engine.world, state.boundaryBodies);
  }

  function applyWindowSweepImpulse() {
    if (!state.lastWindowRect) return;

    const prev = state.lastWindowRect;
    const curr = state.windowRect;
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;

    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      return;
    }

    const primaryIsX = Math.abs(dx) >= Math.abs(dy);

    for (let i = 0; i < state.avatars.length; i += 1) {
      const avatar = state.avatars[i];
      const body = avatar.body;
      const enteredNow =
        isPointInRect(body.position, curr, avatar.halfSize) &&
        !isPointInRect(body.position, prev, avatar.halfSize);

      if (!enteredNow) continue;

      const velocity = body.velocity;
      const nextVelocity = {
        x: velocity.x + dx * WINDOW_SWEEP_PUSH,
        y: velocity.y + dy * WINDOW_SWEEP_PUSH,
      };

      if (primaryIsX) {
        if (dx > 0) {
          nextVelocity.x = Math.max(nextVelocity.x, WINDOW_SWEEP_MIN_SPEED);
        } else {
          nextVelocity.x = Math.min(nextVelocity.x, -WINDOW_SWEEP_MIN_SPEED);
        }
      } else if (dy > 0) {
        nextVelocity.y = Math.max(nextVelocity.y, WINDOW_SWEEP_MIN_SPEED);
      } else {
        nextVelocity.y = Math.min(nextVelocity.y, -WINDOW_SWEEP_MIN_SPEED);
      }

      Body.setVelocity(body, nextVelocity);
      Body.setAngularVelocity(body, body.angularVelocity + randomBetween(-0.08, 0.08));
    }
  }

  function syncAvatarStateFromBodies() {
    const viewWidth = Math.max(1, window.innerWidth);
    const viewHeight = Math.max(1, window.innerHeight);
    const { x: windowX, y: windowY } = state.windowRect;

    for (let i = 0; i < state.avatars.length; i += 1) {
      const avatar = state.avatars[i];
      const body = avatar.body;
      const localX = body.position.x - windowX;
      const localY = body.position.y - windowY;

      const visible =
        localX >= -avatar.halfSize * 2 &&
        localX <= viewWidth + avatar.halfSize * 2 &&
        localY >= -avatar.halfSize * 2 &&
        localY <= viewHeight + avatar.halfSize * 2;

      if (!visible) {
        avatar.el.style.display = "none";
        continue;
      }

      avatar.el.style.display = "block";
      avatar.el.style.transform = `translate3d(${localX - avatar.halfSize}px, ${localY - avatar.halfSize}px, 0) rotate(${body.angle}rad)`;
      avatar.el.style.zIndex = `${Math.round(localY)}`;
    }
  }

  function runPhysicsFrame(timestamp) {
    if (!state.active || state.fading || !state.engine) {
      stopPhysicsLoop();
      return;
    }

    if (!state.lastFrame) {
      state.lastFrame = timestamp;
    }

    syncRects();
    syncWindowRectFromTauri();
    applyWindowSweepImpulse();
    state.lastWindowRect = { ...state.windowRect };

    const deltaMs = Math.min(timestamp - state.lastFrame, PHYSICS_MAX_DELTA_MS);
    state.lastFrame = timestamp;

    Engine.update(state.engine, deltaMs);
    syncAvatarStateFromBodies();
    state.frameId = requestAnimationFrame(runPhysicsFrame);
  }

  function collectContributors() {
    const nodes = document.querySelectorAll(".contributor-card .contributor-avatar img, .contributor-card img");
    const seen = new Set();
    const contributors = [];

    nodes.forEach((node, index) => {
      if (!node || !node.src) return;
      const avatar = String(node.src);
      if (!avatar || seen.has(avatar)) return;
      seen.add(avatar);

      contributors.push({
        name: node.alt || `avatar-${index}`,
        avatar,
      });
    });

    return contributors;
  }

  function normalizeContributors(items) {
    const seen = new Set();
    const contributors = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || typeof item !== "object") continue;
      const avatar = typeof item.avatar === "string" ? item.avatar : "";
      if (!avatar || seen.has(avatar)) continue;
      seen.add(avatar);
      contributors.push({
        name: typeof item.name === "string" && item.name ? item.name : `avatar-${index}`,
        avatar,
      });
    }

    return contributors;
  }

  function findContributorsArray(root) {
    if (!root || (typeof root !== "object" && typeof root !== "function")) {
      return [];
    }

    const queue = [{ value: root, depth: 0 }];
    const visited = new Set();
    let best = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      const { value, depth } = current;

      if (!value || (typeof value !== "object" && typeof value !== "function")) {
        continue;
      }

      if (visited.has(value)) {
        continue;
      }
      visited.add(value);

      if (Array.isArray(value)) {
        const normalized = normalizeContributors(value);
        if (normalized.length > best.length) {
          best = normalized;
        }
        continue;
      }

      if (depth >= 5) {
        continue;
      }

      const nextDepth = depth + 1;
      const objectValue = value;
      for (const key of Object.keys(objectValue)) {
        if (key.startsWith("__v_")) continue;
        let child;
        try {
          child = objectValue[key];
        } catch {
          continue;
        }

        if (child && (typeof child === "object" || typeof child === "function")) {
          queue.push({ value: child, depth: nextDepth });
        }
      }
    }

    return best;
  }

  function collectContributorsFromVueState() {
    const section = document.querySelector(".contributor-section");
    if (!section) return [];

    const candidates = [];
    const markerKeys = Object.keys(section).filter((key) => key.startsWith("__vue"));
    for (const key of markerKeys) {
      const candidate = section[key];
      if (candidate) {
        candidates.push(candidate);
      }
    }

    if (section.__vueParentComponent) {
      let node = section.__vueParentComponent;
      for (let i = 0; i < 6 && node; i += 1) {
        candidates.push(node);
        node = node.parent;
      }
    }

    let best = [];
    for (const candidate of candidates) {
      const normalized = findContributorsArray(candidate);
      if (normalized.length > best.length) {
        best = normalized;
      }
    }

    return best;
  }

  function collectAllContributors() {
    const fromVue = collectContributorsFromVueState();
    if (fromVue.length > 0) {
      return fromVue;
    }

    return collectContributors();
  }

  function createAvatarElement(name, avatarUrl) {
    const wrapper = document.createElement("div");
    wrapper.style.position = "absolute";
    wrapper.style.top = "0";
    wrapper.style.left = "0";
    wrapper.style.width = `${FALLING_AVATAR_SIZE}px`;
    wrapper.style.height = `${FALLING_AVATAR_SIZE}px`;
    wrapper.style.overflow = "hidden";
    wrapper.style.border = "1px solid var(--sl-border-light)";
    wrapper.style.boxShadow = "var(--sl-shadow-md)";
    wrapper.style.background = "var(--sl-bg-secondary)";
    wrapper.style.willChange = "transform";

    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = name;
    img.draggable = false;
    img.style.display = "block";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.style.pointerEvents = "none";
    img.style.userSelect = "none";

    wrapper.appendChild(img);
    return wrapper;
  }

  function setupFallingAvatars(contributors) {
    state.avatars = [];

    if (!state.engine || !state.overlay) return;

    const win = state.windowRect;
    const width = Math.max(win.width, 320);
    const height = Math.max(win.height, 220);
    const centerX = win.x + width / 2;
    const halfSize = FALLING_AVATAR_SIZE / 2;

    const spawnYMin = win.y + Math.max(30, height * 0.25);
    const spawnYMax = win.y + Math.max(60, height * 0.42);
    const launchTargetYMin = win.y + Math.max(20, height * 0.08);
    const launchTargetYMax = win.y + Math.max(40, height * 0.2);
    const launchTargetOffsetX = width * 0.14;

    for (let index = 0; index < contributors.length; index += 1) {
      const contributor = contributors[index];
      const isLeftSide = index % 2 === 0;

      const localXMin = isLeftSide ? halfSize + 8 : Math.max(halfSize + 8, width * 0.82);
      const localXMax = isLeftSide
        ? Math.min(width * 0.18, width - halfSize - 8)
        : Math.max(halfSize + 8, width - halfSize - 8);

      const x = win.x + randomBetween(localXMin, Math.max(localXMin + 1, localXMax));
      const y = randomBetween(spawnYMin, spawnYMax);

      const targetX = centerX + randomBetween(-launchTargetOffsetX, launchTargetOffsetX);
      const targetY = randomBetween(launchTargetYMin, launchTargetYMax);
      const baseLaunchAngle = Math.atan2(targetY - y, targetX - x);
      const launchAngle = baseLaunchAngle + randomBetween(-LAUNCH_ANGLE_JITTER, LAUNCH_ANGLE_JITTER);
      const launchSpeed = randomBetween(LAUNCH_SPEED_MIN, LAUNCH_SPEED_MAX);

      const body = Bodies.rectangle(x, y, FALLING_AVATAR_SIZE, FALLING_AVATAR_SIZE, {
        restitution: AVATAR_RESTITUTION,
        friction: 0.4,
        frictionStatic: 0.9,
        frictionAir: 0.018,
        density: 0.0018,
        slop: 0.03,
      });

      Body.setAngle(body, randomBetween(-Math.PI, Math.PI));
      Body.setVelocity(body, {
        x: Math.cos(launchAngle) * launchSpeed,
        y: Math.sin(launchAngle) * launchSpeed,
      });
      Body.setAngularVelocity(body, randomBetween(-0.13, 0.13));

      const el = createAvatarElement(contributor.name, contributor.avatar);
      state.overlay.appendChild(el);

      state.avatars.push({
        id: `${contributor.name}-${index}`,
        body,
        el,
        halfSize,
      });
    }

    if (state.avatars.length > 0) {
      World.add(
        state.engine.world,
        state.avatars.map((item) => item.body),
      );
    }

    syncAvatarStateFromBodies();
  }

  function clearRuntimeState() {
    stopPhysicsLoop();
    clearTimers();
    detachListeners();
    destroyMatterWorld();
    removeOverlay();
    state.avatars = [];
    state.active = false;
    state.pending = false;
    state.fading = false;
    state.lastWindowRect = null;
  }

  function triggerFadeOut() {
    if (!state.active || state.fading) return;

    state.fading = true;
    stopPhysicsLoop();
    clearTimers();

    if (state.overlay) {
      state.overlay.style.opacity = "0";
    }

    state.fadeTimer = window.setTimeout(() => {
      clearRuntimeState();
    }, FADE_OUT_MS);
  }

  function attachListeners() {
    state.clickHandler = (event) => {
      const target = event && event.target;
      if (!target || !target.closest) return;
      if (target.closest(".about-view")) {
        triggerFadeOut();
      }
    };
    document.addEventListener("click", state.clickHandler, true);

    state.resizeHandler = () => {
      if (!state.active || !state.engine) return;
      syncRects();
      syncOverlayBounds();
      createScreenBounds();
      syncAvatarStateFromBodies();
    };
    window.addEventListener("resize", state.resizeHandler);
  }

  async function startRuntime(contributors) {
    clearRuntimeState();
    syncRects();
    await startWindowTracking();
    syncRects();
    ensureOverlay();
    syncOverlayBounds();

    state.engine = Engine.create({
      gravity: { x: 0, y: 1.2, scale: 0.001 },
    });

    createScreenBounds();
    setupFallingAvatars(contributors);

    if (state.avatars.length === 0) {
      clearRuntimeState();
      return;
    }

    attachListeners();
    state.active = true;
    state.fading = false;
    state.frameId = requestAnimationFrame(runPhysicsFrame);
  }

  function applyRoute(route) {
    const normalized = normalizeRoute(route || "");
    state.currentRoute = normalized;
    clearTimers();

    if (state.currentRoute !== ABOUT_PATH) {
      clearRuntimeState();
      return;
    }

    if (state.active || state.pending) {
      return;
    }

    state.pending = true;
    let attempts = 0;
    const maxAttempts = 20;

    const boot = () => {
      if (state.currentRoute !== ABOUT_PATH) {
        state.pending = false;
        return;
      }

      const contributors = collectAllContributors();
      if (contributors.length === 0 && attempts < maxAttempts) {
        attempts += 1;
        state.retryTimer = window.setTimeout(boot, 150);
        return;
      }

      if (state.currentRoute !== ABOUT_PATH) {
        state.pending = false;
        return;
      }

      state.pending = false;
      if (contributors.length > 0) {
        startRuntime(contributors);
      }
    };

    boot();
  }

  return {
    applyRoute,
  };
}

if (!window[CONTROLLER_KEY]) {
  window[CONTROLLER_KEY] = createController();
}

window[APPLY_KEY] = function applyAvatarFallRoute(route) {
  window[CONTROLLER_KEY].applyRoute(route);
};
