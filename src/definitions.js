// Versioned business definitions ("Begriffe"): what counts as an MQL, an SQL, an opportunity.
// A definition is a list of criteria that ALL must hold for a CRM record. Pure functions only:
// no clock, no database. Criteria are data, never code, so nothing here is ever evaluated as JS.

export const OPS = Object.freeze(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists']);
export const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,40}$/;

/** @returns {string[]} problems; empty when the criteria are valid */
export function validateCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return ['criteria must be a non-empty list'];
  if (criteria.length > 20) return ['at most 20 criteria'];
  const problems = [];
  criteria.forEach((c, i) => {
    if (!c || typeof c !== 'object') return problems.push(`criteria[${i}] must be an object`);
    if (!FIELD_RE.test(c.field ?? '')) problems.push(`criteria[${i}].field must be a snake_case field name`);
    if (!OPS.includes(c.op)) problems.push(`criteria[${i}].op must be one of ${OPS.join(', ')}`);
    if (c.op === 'in' && !(Array.isArray(c.value) && c.value.length > 0)) problems.push(`criteria[${i}].value must be a non-empty list for "in"`);
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && typeof c.value !== 'number') problems.push(`criteria[${i}].value must be a number for "${c.op}"`);
    if (['eq', 'neq'].includes(c.op) && !['string', 'number', 'boolean'].includes(typeof c.value)) problems.push(`criteria[${i}].value must be a string, number or boolean for "${c.op}"`);
  });
  return problems;
}

/** Every CRM field a definition reads. These must reach the CRM, or the definition cannot be measured. */
export function requiredFields(criteria = []) {
  return [...new Set(criteria.map(c => c.field))].sort();
}

const present = v => v !== undefined && v !== null && v !== '';

function test1(c, actual) {
  switch (c.op) {
    case 'exists': return present(actual);
    case 'eq': return actual === c.value;
    case 'neq': return present(actual) && actual !== c.value;
    case 'in': return c.value.includes(actual);
    case 'gt': return typeof actual === 'number' && actual > c.value;
    case 'gte': return typeof actual === 'number' && actual >= c.value;
    case 'lt': return typeof actual === 'number' && actual < c.value;
    case 'lte': return typeof actual === 'number' && actual <= c.value;
    default: return false;
  }
}

/**
 * Does a CRM record meet the definition? A missing field is reported separately from a wrong value,
 * because "we could not measure it" and "it was measured and did not qualify" are different findings.
 */
export function matches(criteria, fields = {}) {
  const missing = [];
  const failed = [];
  for (const c of criteria) {
    if (!present(fields[c.field])) { missing.push(c.field); continue; }
    if (!test1(c, fields[c.field])) failed.push(c.field);
  }
  return { ok: missing.length === 0 && failed.length === 0, missing: [...new Set(missing)], failed: [...new Set(failed)] };
}

export const isPresent = present;
