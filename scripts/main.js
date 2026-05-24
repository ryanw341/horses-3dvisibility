const MODULE_ID = "horses-3dvisibility";
const DEFAULT_TOKEN_HEIGHT = 6;
const MAX_SAMPLE_INSET = 8;
const SAMPLE_INSET_DIVISOR = 4;
const FLOAT_EPSILON = 0.001;
const PATCH_FLAG = Symbol.for(`${MODULE_ID}.patched`);
const OVERLAY_CONTAINER_NAME = `${MODULE_ID}.overlay`;

let originalTestVisibilityRef = null;
const overlayState = {
  container: null,
  sprites: new Map()
};

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getDefaultTokenHeight() {
  try {
    return toFiniteNumber(game.settings.get("wall-height", "defaultLosHeight"), DEFAULT_TOKEN_HEIGHT);
  } catch {
    return DEFAULT_TOKEN_HEIGHT;
  }
}

function getTokenBottomElevation(token, fallbackPoint) {
  return toFiniteNumber(token?.document?.elevation, toFiniteNumber(fallbackPoint?.elevation, 0));
}

function getTokenTopElevation(token, bottomElevation) {
  const tokenLosHeight = toFiniteNumber(token?.losHeight, null);
  if ( tokenLosHeight !== null ) return tokenLosHeight;

  const configuredHeight = token?.document?.flags?.["wall-height"]?.tokenHeight;
  return bottomElevation + toFiniteNumber(configuredHeight, getDefaultTokenHeight());
}

function getTokenBounds(token, fallbackPoint) {
  const width = toFiniteNumber(token?.w, toFiniteNumber(token?.document?.width, 1) * canvas.grid.size);
  const height = toFiniteNumber(token?.h, toFiniteNumber(token?.document?.height, 1) * canvas.grid.size);
  const left = toFiniteNumber(token?.x, toFiniteNumber(fallbackPoint?.x, 0) - (width / 2));
  const top = toFiniteNumber(token?.y, toFiniteNumber(fallbackPoint?.y, 0) - (height / 2));

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height
  };
}

function getSampleInset(bounds) {
  const quarterSize = Math.min(bounds.width, bounds.height) / SAMPLE_INSET_DIVISOR;
  return Math.max(1, Math.min(MAX_SAMPLE_INSET, quarterSize));
}

function getUniqueElevations(bottomElevation, topElevation, fallbackElevation) {
  const elevations = [
    toFiniteNumber(fallbackElevation, bottomElevation),
    bottomElevation,
    bottomElevation + ((topElevation - bottomElevation) / 2),
    topElevation
  ];

  return elevations.filter((elevation, index) => Number.isFinite(elevation)
    && elevations.findIndex(existing => Math.abs(existing - elevation) < FLOAT_EPSILON) === index);
}

function buildVisibilitySamplePoints(token, point) {
  const bounds = getTokenBounds(token, point);
  const inset = getSampleInset(bounds);
  const bottomElevation = getTokenBottomElevation(token, point);
  const topElevation = getTokenTopElevation(token, bottomElevation);
  const elevations = getUniqueElevations(bottomElevation, topElevation, point?.elevation);

  const xs = [bounds.left + inset, bounds.left + (bounds.width / 2), bounds.right - inset];
  const ys = [bounds.top + inset, bounds.top + (bounds.height / 2), bounds.bottom - inset];
  const points = [];

  for ( const elevation of elevations ) {
    for ( const x of xs ) {
      for ( const y of ys ) {
        const isOriginalPoint = Math.abs(x - point.x) < FLOAT_EPSILON
          && Math.abs(y - point.y) < FLOAT_EPSILON
          && Math.abs(elevation - toFiniteNumber(point.elevation, bottomElevation)) < FLOAT_EPSILON;
        if ( !isOriginalPoint ) points.push({x, y, elevation});
      }
    }
  }

  return points;
}

function getCanvasVisibilityClass() {
  return foundry?.canvas?.groups?.CanvasVisibility ?? globalThis.CanvasVisibility;
}

function getTokenClass() {
  return foundry?.canvas?.placeables?.Token ?? globalThis.Token;
}

function shouldTestAlternateVisibility(token) {
  const TokenClass = getTokenClass();
  if ( !TokenClass || !(token instanceof TokenClass) ) return false;
  if ( !canvas?.ready ) return false;
  return canvas.scene?.tokenVision !== false;
}

function patchVisibilityTesting() {
  const VisibilityClass = getCanvasVisibilityClass();
  const prototype = VisibilityClass?.prototype;
  if ( !prototype ) {
    console.warn(`${MODULE_ID} | CanvasVisibility class was not found; height-aware visibility patch was not installed.`);
    return;
  }
  if ( typeof prototype.testVisibility !== "function" ) {
    console.warn(`${MODULE_ID} | CanvasVisibility#testVisibility is unavailable on this Foundry version; height-aware visibility patch was not installed.`);
    return;
  }
  if ( prototype[PATCH_FLAG] ) return;

  const originalTestVisibility = prototype.testVisibility;
  originalTestVisibilityRef = originalTestVisibility;
  prototype.testVisibility = function(point, options = {}) {
    const isVisible = originalTestVisibility.call(this, point, options);
    if ( isVisible ) return true;

    const token = options.object;
    if ( !shouldTestAlternateVisibility(token) ) return false;

    const samplePoints = buildVisibilitySamplePoints(token, point);
    for ( const samplePoint of samplePoints ) {
      if ( originalTestVisibility.call(this, samplePoint, options) ) return true;
    }

    return false;
  };

  Object.defineProperty(prototype, PATCH_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
}

export {buildVisibilitySamplePoints, getTokenBottomElevation, getTokenTopElevation};

function isVisibleOnlyVia3D(token) {
  if ( !originalTestVisibilityRef ) return false;
  if ( !shouldTestAlternateVisibility(token) ) return false;
  const visibility = canvas?.visibility;
  if ( !visibility ) return false;
  if ( token?.document?.hidden ) return false;

  const center = token.center;
  if ( !center || !Number.isFinite(center.x) || !Number.isFinite(center.y) ) return false;
  const probe = {x: center.x, y: center.y, elevation: getTokenBottomElevation(token, center)};
  // Gate probe deliberately uses ground elevation (0) and omits the token object so that
  // height-aware modules (e.g. wall-height) fall back to a plain 2D visibility test. This
  // mirrors the question Foundry's vision/fog mask actually answers when deciding whether
  // to darken the token's pixels, regardless of how high the token sits.
  const groundProbe = {x: center.x, y: center.y, elevation: 0};

  try {
    if ( originalTestVisibilityRef.call(visibility, groundProbe, {}) ) return false;
    for ( const samplePoint of buildVisibilitySamplePoints(token, probe) ) {
      if ( originalTestVisibilityRef.call(visibility, samplePoint, {object: token}) ) return true;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Error while probing alternate visibility:`, err);
  }
  return false;
}

function getOverlayParent() {
  return canvas?.interface ?? canvas?.controls ?? canvas?.stage ?? null;
}

function ensureOverlayContainer() {
  const parent = getOverlayParent();
  if ( !parent ) return null;
  let container = overlayState.container;
  if ( !container || container.destroyed || container.parent !== parent ) {
    if ( container && !container.destroyed ) container.destroy({children: true});
    overlayState.sprites.clear();
    container = new PIXI.Container();
    container.name = OVERLAY_CONTAINER_NAME;
    container.eventMode = "none";
    container.interactiveChildren = false;
    container.sortableChildren = false;
    parent.addChild(container);
    overlayState.container = container;
  }
  return container;
}

function destroyOverlaySprite(id) {
  const sprite = overlayState.sprites.get(id);
  if ( sprite ) {
    if ( !sprite.destroyed ) sprite.destroy();
    overlayState.sprites.delete(id);
  }
}

function getTokenTexture(token) {
  const candidate = token?.texture ?? token?.mesh?.texture;
  if ( candidate && candidate !== PIXI.Texture.EMPTY ) return candidate;
  return null;
}

function refreshTokenOverlay(token) {
  if ( !token?.id ) return;
  const container = ensureOverlayContainer();
  if ( !container ) return;

  const shouldShow = isVisibleOnlyVia3D(token);
  if ( !shouldShow ) {
    destroyOverlaySprite(token.id);
    return;
  }

  const texture = getTokenTexture(token);
  if ( !texture ) {
    destroyOverlaySprite(token.id);
    return;
  }

  let sprite = overlayState.sprites.get(token.id);
  if ( !sprite || sprite.destroyed ) {
    sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.eventMode = "none";
    container.addChild(sprite);
    overlayState.sprites.set(token.id, sprite);
  } else if ( sprite.texture !== texture ) {
    sprite.texture = texture;
  }

  const bounds = getTokenBounds(token, token.center);
  sprite.position.set(bounds.left + (bounds.width / 2), bounds.top + (bounds.height / 2));
  sprite.width = bounds.width;
  sprite.height = bounds.height;
  sprite.rotation = toFiniteNumber(token.mesh?.rotation, toFiniteNumber(token.document?.rotation, 0) * Math.PI / 180);
  sprite.tint = toFiniteNumber(token.mesh?.tint, 0xFFFFFF);
  sprite.alpha = 1;
}

function refreshAllTokenOverlays() {
  if ( !canvas?.ready ) return;
  if ( !originalTestVisibilityRef ) return;
  const tokens = canvas.tokens?.placeables;
  if ( !tokens ) return;

  const activeIds = new Set();
  for ( const token of tokens ) {
    activeIds.add(token.id);
    refreshTokenOverlay(token);
  }
  for ( const id of [...overlayState.sprites.keys()] ) {
    if ( !activeIds.has(id) ) destroyOverlaySprite(id);
  }
}

function teardownOverlays() {
  if ( overlayState.container && !overlayState.container.destroyed ) {
    overlayState.container.destroy({children: true});
  }
  overlayState.container = null;
  overlayState.sprites.clear();
}

Hooks.once("setup", patchVisibilityTesting);
Hooks.on("canvasReady", () => {
  teardownOverlays();
  refreshAllTokenOverlays();
});
Hooks.on("canvasTearDown", teardownOverlays);
Hooks.on("sightRefresh", refreshAllTokenOverlays);
Hooks.on("lightingRefresh", refreshAllTokenOverlays);
Hooks.on("refreshToken", refreshTokenOverlay);
Hooks.on("destroyToken", token => destroyOverlaySprite(token?.id));
Hooks.on("deleteToken", document => destroyOverlaySprite(document?.id));
