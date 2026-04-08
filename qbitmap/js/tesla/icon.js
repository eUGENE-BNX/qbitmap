// Resolve a Tesla vehicle icon URL based on model + exterior color.
// Icons live under /public/<model>/teslaicons/<Color>.png and are served by Caddy.
// Returns null if no matching asset is known — caller should fall back to a logo.

const KNOWN_COLORS = new Set([
  'Quicksilver',
  'MidnightSilverMetallic',
  'PearlWhiteMultiCoat',
  'RedMultiCoat',
  'SolidBlack',
  'DeepBlueMetallic',
]);

function normalizeModel(carType, model) {
  // Tesla vehicle_config.car_type: 'modely', 'model3', 'models', 'modelx'
  if (carType) {
    const c = String(carType).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['modely', 'model3', 'models', 'modelx'].includes(c)) return c;
  }
  if (model) {
    const m = String(model).toLowerCase();
    if (m.includes('model y')) return 'modely';
    if (m.includes('model 3')) return 'model3';
    if (m.includes('model s')) return 'models';
    if (m.includes('model x')) return 'modelx';
  }
  return null;
}

export function getTeslaIconUrl(vehicle) {
  if (!vehicle) return null;
  const model = normalizeModel(vehicle.carType, vehicle.model);
  const color = vehicle.color;
  if (!model || !color || !KNOWN_COLORS.has(color)) return null;
  return `/${model}/teslaicons/${color}.png`;
}
