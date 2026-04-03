/**
 * Structural response comparator.
 * Compares a Chrome (reference) CDP response against a bridge response.
 */

// Fields that are instance-specific and should never be compared
const DEFAULT_IGNORE = new Set([
  'nodeId', 'backendNodeId', 'objectId', 'scriptId', 'styleSheetId',
  'requestId', 'breakpointId', 'executionContextId', 'executionContextUniqueId',
  'timestamp', 'wallTime', 'hash', 'frameId', 'loaderId', 'uniqueId',
  'parentId', 'contentDocumentIndex', 'importedDocumentIndex',
]);

/**
 * Compare Chrome reference result against bridge result.
 *
 * @param {object} chrome - Chrome CDP result
 * @param {object} bridge - Bridge CDP result
 * @param {object} schema - Comparison rules
 * @returns {{ pass: boolean, diffs: string[] }}
 */
export function compareResponses(chrome, bridge, schema = {}) {
  const diffs = [];
  const ignoreFields = new Set([...DEFAULT_IGNORE, ...(schema.ignoreFields || [])]);

  // Check required fields exist
  if (schema.requireFields) {
    for (const path of schema.requireFields) {
      const val = getPath(bridge, path);
      if (val === undefined) {
        diffs.push(`missing required field: ${path}`);
      }
    }
  }

  // Check non-empty arrays/strings
  if (schema.requireNonEmpty) {
    for (const path of schema.requireNonEmpty) {
      const val = getPath(bridge, path);
      if (Array.isArray(val) && val.length === 0) {
        diffs.push(`empty array: ${path} (Chrome has ${getPath(chrome, path)?.length || '?'} items)`);
      } else if (typeof val === 'string' && val === '') {
        diffs.push(`empty string: ${path}`);
      } else if (val === undefined || val === null) {
        diffs.push(`missing/null: ${path}`);
      }
    }
  }

  // Check value assertions
  if (schema.valueAssertions) {
    for (const [path, expected] of Object.entries(schema.valueAssertions)) {
      const val = getPath(bridge, path);
      if (val !== expected) {
        diffs.push(`value mismatch: ${path} = ${JSON.stringify(val)}, expected ${JSON.stringify(expected)}`);
      }
    }
  }

  // Structural deep compare (Chrome fields must exist in bridge with matching types)
  if (chrome && bridge && schema.deepCompare !== false) {
    deepCompare(chrome, bridge, '', ignoreFields, diffs, 0);
  }

  return { pass: diffs.length === 0, diffs };
}

function deepCompare(chrome, bridge, prefix, ignoreFields, diffs, depth) {
  if (depth > 6) return; // Don't go too deep

  if (chrome === null || chrome === undefined) return;
  if (typeof chrome !== 'object') return; // Primitives already type-checked by parent

  if (Array.isArray(chrome)) {
    if (!Array.isArray(bridge)) {
      diffs.push(`type mismatch: ${prefix || 'root'} is array in Chrome, ${typeof bridge} in bridge`);
      return;
    }
    if (chrome.length > 0 && bridge.length === 0) {
      diffs.push(`empty array: ${prefix || 'root'} (Chrome has ${chrome.length} items)`);
      return;
    }
    // Compare first element as representative
    if (chrome.length > 0 && bridge.length > 0) {
      deepCompare(chrome[0], bridge[0], `${prefix}[0]`, ignoreFields, diffs, depth + 1);
    }
    return;
  }

  // Object comparison
  if (typeof bridge !== 'object' || bridge === null || Array.isArray(bridge)) {
    diffs.push(`type mismatch: ${prefix || 'root'} is object in Chrome, ${Array.isArray(bridge) ? 'array' : typeof bridge} in bridge`);
    return;
  }

  for (const key of Object.keys(chrome)) {
    if (ignoreFields.has(key)) continue;

    const path = prefix ? `${prefix}.${key}` : key;

    if (!(key in bridge)) {
      diffs.push(`missing field: ${path}`);
      continue;
    }

    const cVal = chrome[key];
    const bVal = bridge[key];

    if (cVal === null || cVal === undefined) continue; // Chrome null, don't care

    if (typeof cVal !== typeof bVal) {
      diffs.push(`type mismatch: ${path} is ${typeof cVal} in Chrome, ${typeof bVal} in bridge`);
      continue;
    }

    if (typeof cVal === 'object') {
      deepCompare(cVal, bVal, path, ignoreFields, diffs, depth + 1);
    }
  }
}

function getPath(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      current = current[arrMatch[1]];
      if (Array.isArray(current)) current = current[parseInt(arrMatch[2])];
      else return undefined;
    } else {
      current = current[part];
    }
  }
  return current;
}
