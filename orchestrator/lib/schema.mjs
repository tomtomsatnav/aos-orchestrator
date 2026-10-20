// Mini JSON Schema validator (type, required, enum, properties, additionalProperties:false, items, pattern, minimum, maximum, minItems, maxItems, maxLength) plus the
// AOS-1 schemas from ../../schemas. The design's extensions are validated in code: namespaced event types.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const loaded = {};
export function loadSchema(name) {
  if (!loaded[name]) loaded[name] = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'));
  return loaded[name];
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const typeOk = (v, t) => { const a = typeOf(v); return a === t || (t === 'number' && a === 'integer'); };

export function validateSchema(value, schema, at = '$', errs = []) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) { errs.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`); return errs; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: "${value}" !~ /${schema.pattern}/`);
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) errs.push(`${at}: ${value} < ${schema.minimum}`);
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) errs.push(`${at}: ${value} > ${schema.maximum}`);
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength} characters`);
  if (schema.maxItems !== undefined && Array.isArray(value) && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} item(s)`);
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) errs.push(`${at}: needs >= ${schema.minItems} item(s)`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}: missing "${k}"`);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in (schema.properties || {}))) errs.push(`${at}: unknown key "${k}"`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) validateSchema(value[k], s, `${at}.${k}`, errs);
  }
  if (Array.isArray(value) && schema.items) value.forEach((it, i) => validateSchema(it, schema.items, `${at}[${i}]`, errs));
  return errs;
}

// Design extensions: namespaced `orch.*` events and the `human.approve|deny` decisions (design sections 3 and 7).
const EXT_EVENT = /^(orch\.[a-z_]+(\.[a-z_]+)*|human\.(approve|deny))$/;

export function validateEvent(ev) {
  const schema = loadSchema('event');
  if (typeof ev?.type === 'string' && EXT_EVENT.test(ev.type)) {
    const relaxed = { ...schema, properties: { ...schema.properties, type: { type: 'string' } } };
    return validateSchema(ev, relaxed);
  }
  return validateSchema(ev, schema);
}
export const validateGoal = (g) => validateSchema(g, loadSchema('goal'));
export const validateTask = (t) => validateSchema(t, loadSchema('task'));
export const validateAgent = (a) => validateSchema(a, loadSchema('agent'));
export const validateHeartbeat = (h) => validateSchema(h, loadSchema('heartbeat'));
