import Matter from "matter-js";

const { Bodies, Body, Engine, World } = Matter;

const ABOUT_PATH = "/about";
const CONTROLLER_KEY = "__slAvatarFallController";
const APPLY_KEY = "__avatarFallApplyRoute";

const FLOOR_OFFSET = 12;
const PHYSICS_MAX_DELTA_MS = 1000 / 30;
const FALLING_AVATAR_SIZE = 50;
const LAUNCH_SPEED_MIN = 7;
const LAUNCH_SPEED_MAX = 14;
const LAUNCH_ANGLE_JITTER = 0.16;
const AVATAR_RESTITUTION = 0.9;
const BOUNDS_RESTITUTION = 1;
const FADE_OUT_MS = 3000;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
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

function createController() {
  const state = {
    currentRoute: "",
    engine: null,
    boundaryBodies: [],
    avatars: [],
    overlay: null,
    overlayHost: null,
    hostRect: { left: 0, top: 0, width: 1, height: 1 },
    active: false,
    pending: false,
    fading: false,
    frameId: 0,
    lastFrame: 0,
    fadeTimer: 0,
    retryTimer: 0,
    resizeHandler: null,
    clickHandler: null,
    hostResizeObserver: null,
  };

  function getHostElement() {
    return document.querySelector(".app-main");
  }

  function updateHostRect() {
    const host = getHostElement();
    if (host) {
      const rect = host.getBoundingClientRect();
      state.hostRect = {
        left: rect.left,
        top: rect.top,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      };
      state.overlayHost = host;
      return;
    }

    state.hostRect = {
      left: 0,
      top: 0,
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
    };
    state.overlayHost = null;
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

    updateHostRect();
    state.overlay.style.left = `${state.hostRect.left}px`;
    state.overlay.style.top = `${state.hostRect.top}px`;
    state.overlay.style.width = `${state.hostRect.width}px`;
    state.overlay.style.height = `${state.hostRect.height}px`;
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

    if (state.hostResizeObserver) {
      state.hostResizeObserver.disconnect();
      state.hostResizeObserver = null;
    }
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

  function syncAvatarStateFromBodies() {
    for (let i = 0; i < state.avatars.length; i += 1) {
      const avatar = state.avatars[i];
      const body = avatar.body;

      avatar.el.style.transform = `translate3d(${body.position.x - avatar.halfSize}px, ${body.position.y - avatar.halfSize}px, 0) rotate(${body.angle}rad)`;
      avatar.el.style.zIndex = `${Math.round(body.position.y)}`;
    }
  }

  function createWorldBounds() {
    if (!state.engine) return;

    if (state.boundaryBodies.length > 0) {
      World.remove(state.engine.world, state.boundaryBodies);
    }

    const width = Math.max(state.hostRect.width, 320);
    const height = Math.max(state.hostRect.height, 200);
    const wallThickness = 120;
    const floorY = height - FLOOR_OFFSET + wallThickness / 2;

    const options = {
      isStatic: true,
      restitution: BOUNDS_RESTITUTION,
      friction: 0.35,
      frictionStatic: 0.8,
      render: { visible: false },
    };

    state.boundaryBodies = [
      Bodies.rectangle(-wallThickness / 2, height / 2, wallThickness, height * 2, options),
      Bodies.rectangle(width + wallThickness / 2, height / 2, wallThickness, height * 2, options),
      Bodies.rectangle(width / 2, floorY, width * 2, wallThickness, options),
    ];

    World.add(state.engine.world, state.boundaryBodies);
  }

  function clampBodiesToBounds() {
    const width = Math.max(state.hostRect.width, 320);
    const height = Math.max(state.hostRect.height, 200);

    for (let i = 0; i < state.avatars.length; i += 1) {
      const avatar = state.avatars[i];
      const body = avatar.body;
      const clampedX = clamp(body.position.x, avatar.halfSize, Math.max(avatar.halfSize, width - avatar.halfSize));
      const maxY = Math.max(avatar.halfSize, height - FLOOR_OFFSET - avatar.halfSize);
      const clampedY = clamp(body.position.y, avatar.halfSize, maxY);
      Body.setPosition(body, { x: clampedX, y: clampedY });
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

    if (depth >= 4) {
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
    for (let i = 0; i < 5 && node; i += 1) {
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

    const width = Math.max(state.hostRect.width, 320);
    const height = Math.max(state.hostRect.height, 200);
    const centerX = width / 2;
    const halfSize = FALLING_AVATAR_SIZE / 2;

    const spawnYMin = Math.max(40, height * 0.28);
    const spawnYMax = Math.max(spawnYMin + 20, height * 0.46);

    const launchTargetYMin = Math.max(20, height * 0.08);
    const launchTargetYMax = Math.max(launchTargetYMin + 12, height * 0.2);
    const launchTargetOffsetX = width * 0.14;

    for (let index = 0; index < contributors.length; index += 1) {
      const contributor = contributors[index];
      const isLeftSide = index % 2 === 0;
      const sideXMin = isLeftSide ? halfSize + 8 : Math.max(halfSize + 8, width * 0.82);
      const sideXMax = isLeftSide
        ? Math.min(width * 0.18, width - halfSize - 8)
        : Math.max(halfSize + 8, width - halfSize - 8);

      const x = randomBetween(sideXMin, Math.max(sideXMin + 1, sideXMax));
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
      syncOverlayBounds();
      createWorldBounds();
      clampBodiesToBounds();
      syncAvatarStateFromBodies();
    };

    window.addEventListener("resize", state.resizeHandler);

    const host = getHostElement();
    if (host && "ResizeObserver" in window) {
      state.hostResizeObserver = new ResizeObserver(() => {
        if (!state.active || !state.engine) return;
        syncOverlayBounds();
        createWorldBounds();
        clampBodiesToBounds();
        syncAvatarStateFromBodies();
      });

      state.hostResizeObserver.observe(host);
    }
  }

  function startRuntime(contributors) {
    clearRuntimeState();
    updateHostRect();
    ensureOverlay();
    syncOverlayBounds();

    state.engine = Engine.create({
      gravity: { x: 0, y: 1.2, scale: 0.001 },
    });

    createWorldBounds();
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
