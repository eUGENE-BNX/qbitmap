// Map Tesla's vehicle_config.trim_badging codes to readable labels.
// Source: observed values from /api/1/vehicles/{id}/vehicle_data?endpoints=vehicle_config.
const TRIM_LABELS = {
  p: 'Performance',
  pl: 'Plaid',
  '74': 'Long Range RWD',
  '74d': 'Long Range AWD',
  '100d': 'Long Range AWD',
  '85': 'Long Range',
  '85d': 'Long Range AWD',
  '50': 'Standard Range',
  '60': 'Standard Range',
  '60d': 'Standard Range AWD',
};

function trimLabel(code) {
  if (!code) return null;
  const c = String(code).toLowerCase();
  if (TRIM_LABELS[c]) return TRIM_LABELS[c];
  // Pattern fallback for codes like p74d, p100d, pl100d that pair the
  // performance/plaid prefix with a battery-and-drive suffix Tesla added later.
  if (c.startsWith('pl')) return 'Plaid';
  if (c.startsWith('p')) return 'Performance';
  return code.toUpperCase();
}

function formatModel(model, trimCode) {
  if (!model) return null;
  const label = trimLabel(trimCode);
  return label ? `${model} ${label}` : model;
}

module.exports = { trimLabel, formatModel };
