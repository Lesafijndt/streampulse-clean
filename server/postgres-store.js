import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Server-only, JSON document compatibility layer. A namespace is one CAS row,
// so queue changes, receipts, settings and history share an atomic boundary.
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const copy = value => value === undefined ? undefined : structuredClone(value);
function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status, statusCode: status });
}
function namespaceName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw failure('invalid_namespace');
  return value;
}
function pathParts(path) {
  if (typeof path !== 'string' || !path || path.length > 2048) throw failure('invalid_path');
  const parts = path.split('/');
  if (parts.some(part => !part || unsafeKeys.has(part) || /[\u0000-\u001f]/.test(part))) throw failure('invalid_path');
  return parts;
}
function fieldParts(field) {
  if (typeof field !== 'string' || !field) throw failure('invalid_field');
  const parts = field.split('.');
  if (parts.some(part => !part || unsafeKeys.has(part))) throw failure('invalid_field');
  return parts;
}
function fieldValue(data, field) {
  return fieldParts(field).reduce((value, key) => plain(value) && own(value, key) ? value[key] : undefined, data);
}
function setField(data, field, value) {
  const keys = fieldParts(field);
  const last = keys.pop();
  let parent = data;
  for (const key of keys) {
    if (!plain(parent[key])) parent[key] = {};
    parent = parent[key];
  }
  parent[last] = value;
}
function clean(value, inArray = false) {
  if (value === undefined && !inArray) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(entry => clean(entry, true));
  if (!plain(value)) throw failure('invalid_document_value');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (unsafeKeys.has(key)) throw failure('invalid_document_key');
    if (entry !== undefined) result[key] = clean(entry);
  }
  return result;
}
function resolve(value, previous, merge = false) {
  if (plain(value) && own(value, '__op')) {
    if (value.__op === 'increment' && typeof value.value === 'number' && Number.isFinite(value.value)) {
      const result = (typeof previous === 'number' ? previous : 0) + value.value;
      if (!Number.isFinite(result)) throw failure('invalid_increment');
      return result;
    }
    if (value.__op === 'arrayUnion' && Array.isArray(value.values)) {
      const result = Array.isArray(previous) ? copy(previous) : [];
      for (const entry of value.values) {
        const candidate = resolve(entry, undefined);
        if (!result.some(existing => isDeepStrictEqual(existing, candidate))) result.push(candidate);
      }
      return result;
    }
    throw failure('invalid_transform');
  }
  if (Array.isArray(value)) return value.map(entry => resolve(entry, undefined));
  if (!plain(value)) return value;
  // An explicitly empty map replaces the old map, including with merge:true.
  const result = merge && Object.keys(value).length && plain(previous) ? copy(previous) : {};
  for (const [key, entry] of Object.entries(value)) result[key] = resolve(entry, previous?.[key], merge);
  return result;
}
function compare(a, b) {
  if (isDeepStrictEqual(a, b)) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * readState(): {version:number, documents:Record<fullDocumentPath, JSON>}
 * compareAndSwap(expectedVersion, documents): boolean (true only on commit).
 * Transaction callbacks may rerun on contention; keep external side effects
 * outside the callback, just as with Firestore transactions.
 */
export function createDocumentStore({ readState: readBackend, compareAndSwap, readVersion,
  namespace = process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck', maxAttempts = 8 }) {
  namespaceName(namespace);
  if (typeof readBackend !== 'function' || typeof compareAndSwap !== 'function' ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw failure('invalid_store_configuration');
  const prefix = `artifacts/${namespace}/public/data/`;
  function documentPath(path) {
    if (pathParts(path).length !== 6 || !path.startsWith(prefix)) throw failure('invalid_document_path');
    return path;
  }
  function collectionPath(path) {
    if (pathParts(path).length !== 5 || !path.startsWith(prefix)) throw failure('invalid_collection_path');
    return path;
  }
  async function state() {
    const result = await readBackend();
    const version = Number(result?.version);
    if (!Number.isSafeInteger(version) || version < 0 || !plain(result?.documents)) throw failure('invalid_store_state', 503);
    return { version, documents: copy(result.documents) };
  }
  async function getVersion() {
    const version = readVersion ? Number(await readVersion()) : (await state()).version;
    if (!Number.isSafeInteger(version) || version < 0) throw failure('invalid_store_state', 503);
    return version;
  }
  function snapshot(path, documents) {
    documentPath(path);
    const value = own(documents, path) ? copy(documents[path]) : undefined;
    return { id: path.split('/').at(-1), ref: doc(path), exists: value !== undefined,
      data: () => copy(value), get: field => copy(fieldValue(value, field)) };
  }
  function operation(type, ref, data, options) {
    return { type, path: documentPath(typeof ref === 'string' ? ref : ref?.path),
      ...(type === 'delete' ? {} : { data: clean(data) }), ...(options?.merge ? { merge: true } : {}) };
  }
  function apply(documents, operations) {
    for (const op of operations) {
      const path = documentPath(op.path);
      const exists = own(documents, path);
      if (op.type === 'delete') { delete documents[path]; continue; }
      if (!['create', 'set', 'update'].includes(op.type) || !plain(op.data)) throw failure('invalid_operation');
      const data = clean(op.data);
      if (op.type === 'create' && exists) throw failure('already_exists', 409);
      if (op.type === 'update' && !exists) throw failure('not_found', 404);
      if (op.type === 'update') {
        const next = copy(documents[path]);
        for (const [field, value] of Object.entries(data)) setField(next, field, resolve(value, fieldValue(next, field)));
        documents[path] = next;
      } else documents[path] = resolve(data, documents[path], op.merge === true);
    }
    return documents;
  }
  async function commitOperations(operations, { expectedVersion } = {}) {
    if (!Array.isArray(operations)) throw failure('invalid_operations');
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) throw failure('invalid_version');
    // Freeze the submitted values before any await or retry.
    operations = copy(operations);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = await state();
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw failure('conflict', 409);
      if (!operations.length) return { version: current.version };
      const documents = apply(current.documents, operations);
      if (await compareAndSwap(current.version, documents)) return { version: current.version + 1 };
      if (expectedVersion !== undefined) throw failure('conflict', 409);
    }
    throw failure('conflict', 409);
  }
  function writer(operations) {
    const target = {};
    for (const type of ['create', 'set', 'update', 'delete']) target[type] = (ref, data, options) => {
      operations.push(operation(type, ref, data, options));
      return target;
    };
    return target;
  }
  async function runTransaction(callback) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const current = await state();
      const operations = [];
      const transaction = writer(operations);
      transaction.get = async ref => ref?._query
        ? querySnapshot(ref, current.documents) : snapshot(ref?.path, current.documents);
      transaction.getAll = (...refs) => Promise.all(refs.map(ref => transaction.get(ref)));
      const result = await callback(transaction);
      if (!operations.length) return result;
      if (await compareAndSwap(current.version, apply(current.documents, operations))) return result;
    }
    throw failure('conflict', 409);
  }
  function doc(path) {
    const parts = pathParts(path);
    if (parts.length % 2) throw failure('invalid_document_path');
    return { path, id: parts.at(-1),
      collection: name => collection(path + '/' + name),
      get: async () => snapshot(path, (await state()).documents),
      set: (data, options) => commitOperations([operation('set', path, data, options)]),
      update: data => commitOperations([operation('update', path, data)]),
      create: data => commitOperations([operation('create', path, data)]),
      delete: () => commitOperations([operation('delete', path)]),
    };
  }
  function querySnapshot(query, documents) {
    const { path, _query: config } = query;
    collectionPath(path);
    const field = (entry, name) => name === '__name__' ? entry.id : entry.get(name);
    const filters = config.filters || [];
    const orders = config.orders.length ? [...config.orders] : [['__name__', 'asc']];
    if (!orders.some(([name]) => name === '__name__')) orders.push(['__name__', orders.at(-1)[1]]);
    let docs = Object.keys(documents).filter(key => key.startsWith(path + '/') && key.split('/').length === 6)
      .map(key => snapshot(key, documents));
    for (const [name, operator, value] of filters) docs = docs.filter(entry => {
      const actual = field(entry, name);
      if (actual === undefined) return false;
      switch (operator) {
        case '==': return isDeepStrictEqual(actual, value);
        case '!=': return !isDeepStrictEqual(actual, value);
        case '<': return compare(actual, value) < 0;
        case '<=': return compare(actual, value) <= 0;
        case '>': return compare(actual, value) > 0;
        case '>=': return compare(actual, value) >= 0;
        case 'in': return value.some(candidate => isDeepStrictEqual(actual, candidate));
        case 'array-contains': return Array.isArray(actual) && actual.some(candidate => isDeepStrictEqual(candidate, value));
        default: throw failure('unsupported_query_operator');
      }
    });
    docs = docs.filter(entry => orders.every(([name]) => field(entry, name) !== undefined));
    const compareValues = (entry, values) => {
      for (let i = 0; i < values.length; i++) {
        const compared = compare(field(entry, orders[i][0]), values[i]) * (orders[i][1] === 'desc' ? -1 : 1);
        if (compared) return compared;
      }
      return 0;
    };
    docs.sort((a, b) => compareValues(a, orders.map(([name]) => field(b, name))));
    if (config.cursor) {
      const values = config.cursor.length === 1 && typeof config.cursor[0]?.data === 'function'
        ? orders.map(([name]) => field(config.cursor[0], name)) : config.cursor;
      if (!values.length || values.length > orders.length) throw failure('invalid_query_cursor');
      docs = docs.filter(entry => compareValues(entry, values) > 0);
    }
    if (config.limit !== undefined) docs = docs.slice(0, config.limit);
    return { docs, size: docs.length, empty: docs.length === 0, forEach: callback => docs.forEach(callback) };
  }
  function collection(path, config = { orders: [], filters: [] }) {
    const parts = pathParts(path);
    if (!(parts.length % 2)) throw failure('invalid_collection_path');
    const query = { path, id: parts.at(-1), _query: config,
      doc: (id = randomUUID()) => doc(path + '/' + id),
      get: async () => querySnapshot(query, (await state()).documents),
      orderBy: (name, direction = 'asc') => {
        name = typeof name === 'string' ? name : '__name__';
        if (name !== '__name__') fieldParts(name);
        if (!['asc', 'desc'].includes(direction)) throw failure('invalid_query_order');
        return collection(path, { ...config, orders: [...config.orders, [name, direction]] });
      },
      where: (name, operator, value) => {
        name = typeof name === 'string' ? name : '__name__';
        if (name !== '__name__') fieldParts(name);
        if (!['==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains'].includes(operator) ||
            (operator === 'in' && !Array.isArray(value))) throw failure('unsupported_query_operator');
        return collection(path, { ...config, filters: [...config.filters, [name, operator, copy(value)]] });
      },
      limit: count => {
        if (!Number.isInteger(count) || count < 1) throw failure('invalid_query_limit');
        return collection(path, { ...config, limit: count });
      },
      startAfter: (...values) => collection(path, { ...config, cursor: values }),
    };
    return query;
  }
  return { namespace, collection, doc, runTransaction, readState: state,
    getVersion, commitOperations,
    batch: () => {
      const operations = [];
      const batch = writer(operations);
      batch.commit = () => commitOperations(operations);
      return batch;
    },
  };
}

let connection;
let connectionUrl;
let initialized;
const stores = new Map();
async function postgres() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw failure('postgres_not_configured', 503);
  if (!connection || connectionUrl !== url) {
    const { neon } = await import('@neondatabase/serverless');
    connection = neon(url);
    connectionUrl = url;
    initialized = undefined;
    stores.clear();
  }
  if (!initialized) initialized = connection.query(`CREATE TABLE IF NOT EXISTS streampulse_state (
    namespace TEXT PRIMARY KEY,
    version BIGINT NOT NULL DEFAULT 0,
    documents JSONB NOT NULL DEFAULT '{}'::jsonb
  )`).catch(error => { initialized = undefined; throw error; });
  await initialized;
  return connection;
}

export async function getPostgresStore(namespace = process.env.VITE_FIREBASE_NAMESPACE || 'streampulse-live-deck') {
  namespaceName(namespace);
  const sql = await postgres();
  if (!stores.has(namespace)) {
    const pending = (async () => {
      await sql.query('INSERT INTO streampulse_state(namespace) VALUES ($1) ON CONFLICT (namespace) DO NOTHING', [namespace]);
      return createDocumentStore({ namespace,
        readVersion: async () => {
          const [row] = await sql.query('SELECT version FROM streampulse_state WHERE namespace = $1', [namespace]);
          if (!row) throw failure('postgres_state_missing', 503);
          return Number(row.version);
        },
        readState: async () => {
          const [row] = await sql.query('SELECT version, documents FROM streampulse_state WHERE namespace = $1', [namespace]);
          if (!row) throw failure('postgres_state_missing', 503);
          return { version: Number(row.version), documents: row.documents };
        },
        compareAndSwap: async (version, documents) => {
          const rows = await sql.query(`UPDATE streampulse_state SET documents = $3::jsonb, version = version + 1
            WHERE namespace = $1 AND version = $2 RETURNING version`, [namespace, version, JSON.stringify(documents)]);
          return rows.length === 1;
        },
      });
    })().catch(error => { stores.delete(namespace); throw error; });
    stores.set(namespace, pending);
  }
  return stores.get(namespace);
}

export async function readState(namespace) { return (await getPostgresStore(namespace)).readState(); }
export async function getVersion(namespace) { return (await getPostgresStore(namespace)).getVersion(); }
export async function commitOperations(namespace, operations, options) {
  return (await getPostgresStore(namespace)).commitOperations(operations, options);
}
