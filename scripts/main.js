const MODULE_ID = "horses-3dvisibility";
const DEFAULT_TOKEN_HEIGHT = 6;
const MAX_SAMPLE_INSET = 8;
const SAMPLE_INSET_DIVISOR = 4;
const FLOAT_EPSILON = 0.001;
const PATCH_FLAG = Symbol.for(`${MODULE_ID}.patched`);
const OVERLAY_CONTAINER_NAME = `${MODULE_ID}.overlay`;
const WALL_HEIGHT_MODULE_ID = "wall-height";

let originalTestVisibilityRef = null;
const overlayState = {
  container: null,
  // tokenId -> {mesh, originalParent, originalIndex}
  meshes: new Map()
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

function getGridDistancePerPixel() {
  const gridSize = toFiniteNumber(canvas?.grid?.size, toFiniteNumber(canvas?.dimensions?.size, 1));
  const gridDistance = toFiniteNumber(canvas?.scene?.grid?.distance, toFiniteNumber(canvas?.dimensions?.distance, 1));
  return gridSize > 0 ? gridDistance / gridSize : 1;
}

function getWallDocument(wall) {
  return wall?.document ?? wall;
}

function getWallCoordinates(wall) {
  const document = getWallDocument(wall);
  const coords = document?.c ?? wall?.coords;
  if ( !Array.isArray(coords) || coords.length < 4 ) return null;
  const [x1, y1, x2, y2] = coords.map(value => toFiniteNumber(value, null));
  if ( [x1, y1, x2, y2].some(value => value === null) ) return null;
  return {x1, y1, x2, y2};
}

function getWallHeightBounds(wall) {
  const document = getWallDocument(wall);
  const flags = document?.flags?.[WALL_HEIGHT_MODULE_ID] ?? {};
  // Optional Wall Height flags narrow wall bounds; unflagged walls remain full-height blockers.
  return {
    bottom: toFiniteNumber(flags.bottom, -Infinity),
    top: toFiniteNumber(flags.top, Infinity)
  };
}

function isWallSightBlocking(wall) {
  const document = getWallDocument(wall);
  const doorStates = globalThis.CONST?.WALL_DOOR_STATES;
  if ( doorStates && document?.door && document?.ds === doorStates.OPEN ) return false;

  const senseTypes = globalThis.CONST?.WALL_SENSE_TYPES;
  if ( senseTypes && document?.sight === senseTypes.NONE ) return false;
  return document?.sight !== 0;
}

function getSegmentIntersectionFraction(a, b, wallCoords) {
  const rayX = b.x - a.x;
  const rayY = b.y - a.y;
  const wallX = wallCoords.x2 - wallCoords.x1;
  const wallY = wallCoords.y2 - wallCoords.y1;
  const denominator = (rayX * wallY) - (rayY * wallX);
  if ( Math.abs(denominator) < FLOAT_EPSILON ) return null;

  const dx = wallCoords.x1 - a.x;
  const dy = wallCoords.y1 - a.y;
  const rayFraction = ((dx * wallY) - (dy * wallX)) / denominator;
  const wallFraction = ((dx * rayY) - (dy * rayX)) / denominator;
  if ( rayFraction < FLOAT_EPSILON || rayFraction > (1 - FLOAT_EPSILON) ) return null;
  if ( wallFraction < -FLOAT_EPSILON || wallFraction > (1 + FLOAT_EPSILON) ) return null;
  return rayFraction;
}

function doSegmentBoundsOverlap(a, b, wallCoords) {
  const rayLeft = Math.min(a.x, b.x) - FLOAT_EPSILON;
  const rayRight = Math.max(a.x, b.x) + FLOAT_EPSILON;
  const rayTop = Math.min(a.y, b.y) - FLOAT_EPSILON;
  const rayBottom = Math.max(a.y, b.y) + FLOAT_EPSILON;
  const wallLeft = Math.min(wallCoords.x1, wallCoords.x2);
  const wallRight = Math.max(wallCoords.x1, wallCoords.x2);
  const wallTop = Math.min(wallCoords.y1, wallCoords.y2);
  const wallBottom = Math.max(wallCoords.y1, wallCoords.y2);
  return rayLeft <= wallRight && rayRight >= wallLeft && rayTop <= wallBottom && rayBottom >= wallTop;
}

function getVisionSourcesForToken(token) {
  const sources = canvas?.effects?.visionSources;
  if ( !sources ) return [];
  const values = sources instanceof Map ? sources.values() : sources;
  // Older Foundry sources may not expose `active`; only skip sources explicitly marked inactive.
  return [...values].filter(source => source && source.object !== token && source.active !== false);
}

function getVisionSourcePoint(source) {
  const object = source?.object;
  const center = object?.center;
  const origin = source?.origin;
  const x = toFiniteNumber(source?.x, toFiniteNumber(origin?.x, toFiniteNumber(center?.x, null)));
  const y = toFiniteNumber(source?.y, toFiniteNumber(origin?.y, toFiniteNumber(center?.y, null)));
  if ( x === null || y === null ) return null;

  const elevation = toFiniteNumber(
    source?.elevation,
    toFiniteNumber(origin?.elevation, toFiniteNumber(object?.losHeight, toFiniteNumber(object?.document?.elevation, 0)))
  );
  return {x, y, elevation};
}

function isPixelDistanceWithinSourceRadius(source, pixelDistance) {
  if ( source?.radius === Infinity ) return true;
  if ( source?.radius == null ) return false;
  const radius = Number(source?.radius);
  if ( !Number.isFinite(radius) ) return false;
  if ( radius <= 0 ) return false;
  return pixelDistance <= (radius + FLOAT_EPSILON);
}

function isSampleClearFromSource(source, samplePoint) {
  const sourcePoint = getVisionSourcePoint(source);
  if ( !sourcePoint ) return false;
  const pixelDistance = Math.hypot(samplePoint.x - sourcePoint.x, samplePoint.y - sourcePoint.y);
  if ( !isPixelDistanceWithinSourceRadius(source, pixelDistance) ) return false;

  const walls = canvas?.walls?.placeables ?? [];
  const distancePerPixel = getGridDistancePerPixel();
  for ( const wall of walls ) {
    if ( !isWallSightBlocking(wall) ) continue;
    const wallCoords = getWallCoordinates(wall);
    if ( !wallCoords ) continue;
    if ( !doSegmentBoundsOverlap(sourcePoint, samplePoint, wallCoords) ) continue;

    const fraction = getSegmentIntersectionFraction(sourcePoint, samplePoint, wallCoords);
    if ( fraction === null ) continue;

    const {bottom, top} = getWallHeightBounds(wall);
    const sourceElevation = toFiniteNumber(sourcePoint.elevation, 0);
    const targetElevation = toFiniteNumber(samplePoint.elevation, sourceElevation);
    const horizontalDistance = pixelDistance * distancePerPixel;
    if ( horizontalDistance <= FLOAT_EPSILON ) continue;
    const distanceToWall = horizontalDistance * fraction;
    // Interpolate the sight-line height at the wall intersection before comparing it to wall bounds.
    const lineElevation = sourceElevation + ((targetElevation - sourceElevation) * (distanceToWall / horizontalDistance));

    if ( lineElevation > (top + FLOAT_EPSILON) ) continue;
    if ( lineElevation < (bottom - FLOAT_EPSILON) ) continue;
    return false;
  }
  return true;
}

function isTokenVisibleVia3DGeometry(token, point) {
  if ( !shouldTestAlternateVisibility(token) ) return false;
  const probe = {
    x: toFiniteNumber(point?.x, token.center?.x),
    y: toFiniteNumber(point?.y, token.center?.y),
    elevation: getTokenBottomElevation(token, point)
  };
  if ( !Number.isFinite(probe.x) || !Number.isFinite(probe.y) ) return false;

  const samplePoints = buildVisibilitySamplePoints(token, probe);
  const sources = getVisionSourcesForToken(token);
  for ( const source of sources ) {
    for ( const samplePoint of samplePoints ) {
      if ( isSampleClearFromSource(source, samplePoint) ) return true;
    }
  }
  return false;
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

    // Snapshot the detection filter as it was when the standard visibility call returned
    // false. The original call above may have set a non-sight detection filter (e.g. the
    // outline overlay from tremorsense) as a side effect even while ultimately returning
    // false; in that case the snapshot already reflects "the filter Foundry wants when
    // this token isn't being seen by sight". For our 3D fallback we model "the token is
    // geometrically in sight once height is considered", so any non-sight detection
    // filter set by a sample-point probe must be reverted before we return true,
    // otherwise the token renders as a bare silhouette.
    // `token` is guaranteed non-null here because shouldTestAlternateVisibility above
    // requires it to be a Token instance.
    const preFilter = token.detectionFilter ?? null;
    const restoreFilter = () => {
      if ( token.detectionFilter !== preFilter ) token.detectionFilter = preFilter;
    };
    const samplePoints = buildVisibilitySamplePoints(token, point);
    for ( const samplePoint of samplePoints ) {
      if ( originalTestVisibility.call(this, samplePoint, options) ) {
        restoreFilter();
        return true;
      }
    }
    if ( isTokenVisibleVia3DGeometry(token, point) ) {
      restoreFilter();
      return true;
    }

    restoreFilter();
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
  // `probe` carries the token's actual bottom elevation and is used as the seed point
  // for buildVisibilitySamplePoints below, which expands it into a 3D grid of samples
  // across the token's volume. It is intentionally NOT used for the gate test.
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
    if ( isTokenVisibleVia3DGeometry(token, probe) ) return true;
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
    if ( container && !container.destroyed ) {
      // Restore any meshes we'd reparented before destroying the stale container, so we
      // never destroy the real token visuals along with our container.
      restoreAllMeshes();
      container.destroy({children: false});
    }
    container = new PIXI.Container();
    container.name = OVERLAY_CONTAINER_NAME;
    container.eventMode = "passive";
    container.interactiveChildren = true;
    container.sortableChildren = false;
    parent.addChild(container);
    overlayState.container = container;
  }
  return container;
}

function restoreMesh(id) {
  const entry = overlayState.meshes.get(id);
  if ( !entry ) return;
  overlayState.meshes.delete(id);
  const {mesh, originalParent, originalIndex} = entry;
  if ( !mesh || mesh.destroyed ) return;
  if ( !originalParent || originalParent.destroyed ) return;
  if ( mesh.parent === originalParent ) return;
  // PIXI's addChildAt accepts indices in [0, children.length]; passing children.length
  // appends. If siblings have disappeared since we captured the original index we
  // gracefully fall back to appending rather than throwing.
  const clampedIndex = Math.max(0, Math.min(originalIndex, originalParent.children.length));
  originalParent.addChildAt(mesh, clampedIndex);
}

function restoreAllMeshes() {
  for ( const id of [...overlayState.meshes.keys()] ) restoreMesh(id);
}

function reparentTokenMesh(token, container) {
  const mesh = token?.mesh;
  if ( !mesh || mesh.destroyed ) return;
  if ( mesh.parent === container ) return;

  const currentParent = mesh.parent;
  const existing = overlayState.meshes.get(token.id);
  // Preserve the first non-overlay parent we ever saw so we always restore to the layer
  // Foundry expects, even if the mesh was briefly placed back in a transient container.
  const originalParent = existing?.originalParent && !existing.originalParent.destroyed
    ? existing.originalParent
    : (currentParent && currentParent !== container ? currentParent : null);
  const originalIndex = existing?.originalParent && !existing.originalParent.destroyed
    ? existing.originalIndex
    : (originalParent ? Math.max(0, originalParent.getChildIndex(mesh)) : 0);

  if ( !originalParent ) return;

  overlayState.meshes.set(token.id, {mesh, originalParent, originalIndex});
  container.addChild(mesh);
}

function refreshTokenOverlay(token) {
  if ( !token?.id ) return;

  const shouldShow = isVisibleOnlyVia3D(token);
  if ( !shouldShow ) {
    restoreMesh(token.id);
    return;
  }

  const container = ensureOverlayContainer();
  if ( !container ) return;

  // When our 3D fallback is the reason this token is visible, any detection filter still
  // attached is a stale side effect from a prior probe (e.g. an outline shader from a
  // non-sight detection mode) and would render the reparented mesh as a bare silhouette.
  // Clear it defensively. We only do this on the overlay path, so detection filters set
  // legitimately by Foundry when a non-sight mode is the real reason the token is seen
  // (in which case isVisibleOnlyVia3D returns false) are left untouched.
  if ( token.detectionFilter ) token.detectionFilter = null;

  reparentTokenMesh(token, container);
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
  for ( const id of [...overlayState.meshes.keys()] ) {
    if ( !activeIds.has(id) ) restoreMesh(id);
  }
}

function teardownOverlays() {
  // Restore meshes before destroying the container so we don't tear down real token visuals.
  restoreAllMeshes();
  if ( overlayState.container && !overlayState.container.destroyed ) {
    overlayState.container.destroy({children: false});
  }
  overlayState.container = null;
  overlayState.meshes.clear();
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
Hooks.on("destroyToken", token => restoreMesh(token?.id));
Hooks.on("deleteToken", document => restoreMesh(document?.id));
