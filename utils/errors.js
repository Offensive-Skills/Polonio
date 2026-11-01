'use strict';

/**
 * Human readable message for an error thrown by web3 or the node.
 *
 * web3 v4 wraps reverts in a generic ContractExecutionError ("Error happened
 * while trying to execute a function inside a smart contract") and keeps the
 * useful part, the revert reason or the decoded custom error, in `cause` /
 * `innerError`. This digs it out so the player sees *why* a call failed.
 */
function describeError(err) {
  if (err === null || err === undefined) return 'Error desconocido';
  if (typeof err !== 'object') return String(err);

  const seen = new Set();
  let current = err;
  let deepestMessage = null;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);

    if (current.errorName) {
      return `execution reverted: ${current.errorName}(${formatErrorArgs(current.errorArgs)})`;
    }
    if (typeof current.reason === 'string' && current.reason) {
      return `execution reverted: ${current.reason}`;
    }
    if (typeof current.message === 'string' && current.message) {
      deepestMessage = current.message;
    }
    current = current.cause || current.innerError || null;
  }

  return deepestMessage || err.message || String(err);
}

/**
 * Format decoded custom error arguments ("a=3, who=0x...").
 * web3 returns them as an object with both positional and named keys.
 */
function formatErrorArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const length = Number(args.__length__) || 0;
  const named = Object.keys(args).filter((k) => k !== '__length__' && isNaN(Number(k)));
  if (named.length > 0) {
    return named.map((k) => `${k}=${formatValue(args[k])}`).join(', ');
  }
  return Array.from({ length }, (_, i) => formatValue(args[i])).join(', ');
}

function formatValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (value && typeof value === 'object') return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return String(value);
}

module.exports = { describeError };
