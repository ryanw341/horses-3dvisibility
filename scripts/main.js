const MODULE_ID = "horses-3dvisibility";
const DEFAULT_TOKEN_HEIGHT = 6;
const MAX_SAMPLE_INSET = 8;

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
  const losHeight = toFiniteNumber(token?.losHeight, null);
  if ( losHeight !== null ) return losHeight;

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
  const quarterSize = Math.min(bounds.width, bounds.height) / 4;
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
    && elevations.findIndex(existing => Math.abs(existing - elevation) < 0.001) === index);
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
        const isOriginalPoint = Math.abs(x - point.x) < 0.001
          && Math.abs(y - point.y) < 0.001
          && Math.abs(elevation - toFiniteNumber(point.elevation, bottomElevation)) < 0.001;
        if ( !isOriginalPoint ) points.push({x, y, elevation});
      }
    }
  }

  return points;
}

function shouldTestAlternateVisibility(token) {
  if ( !(token instanceof globalThis.Token) ) return false;
  if ( !canvas?.ready ) return false;
  return canvas.scene?.tokenVision !== false;
}

function patchVisibilityTesting() {
  const prototype = globalThis.CanvasVisibility?.prototype;
  if ( !prototype || prototype[MODULE_ID] ) return;

  const originalTestVisibility = prototype.testVisibility;
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

  Object.defineProperty(prototype, MODULE_ID, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
}

export {buildVisibilitySamplePoints, getTokenBottomElevation, getTokenTopElevation};

Hooks.once("setup", patchVisibilityTesting);
