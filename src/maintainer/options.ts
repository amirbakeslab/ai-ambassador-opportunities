// Maintainer option specs load eagerly so argument errors are reported before
// any maintainer module (and credential handling) is imported.
const sheet = {
  'sheet-id': { type: 'string' },
  tab: { type: 'string' },
} as const;

export const maintainerOptions = {
  review: { output: { type: 'string', short: 'o' }, force: { type: 'boolean' }, against: { type: 'string' }, ...sheet },
  sync: {
    changes: { type: 'string' },
    'dry-run': { type: 'boolean' },
    apply: { type: 'boolean' },
    'backup-dir': { type: 'string' },
    'allow-stale': { type: 'boolean' },
    ...sheet,
  },
  backup: { 'output-dir': { type: 'string' }, 'public-csv': { type: 'boolean' }, ...sheet },
  restore: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, 'backup-dir': { type: 'string' }, ...sheet },
} as const;
