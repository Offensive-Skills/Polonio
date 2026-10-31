'use strict';

/**
 * Symbolic references allowed in challenge metadata (setup actions and
 * validation rules), so challenge authors never hardcode addresses:
 *
 *   "$deployer"        accounts[0] (admin account that deploys the challenge)
 *   "$player"          accounts[1] (the player's main account)
 *   "$account:N"       accounts[N]
 *   "$contract:Name"   address of the challenge contract deployed as "Name"
 *   "$ether:X"         X ether expressed in wei (decimal string)
 *
 * Any other value is returned unchanged. Arrays are resolved element by element.
 */
function createResolver({ web3, accounts, contracts }) {
  const resolve = (value) => {
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value !== 'string' || !value.startsWith('$')) return value;

    if (value === '$deployer') return accounts[0];
    if (value === '$player') return accounts[1];

    const match = value.match(/^\$(account|contract|ether):(.+)$/);
    if (!match) {
      throw new Error(`Unknown reference "${value}"`);
    }

    const [, kind, arg] = match;
    switch (kind) {
      case 'account': {
        const index = Number(arg);
        if (!Number.isInteger(index) || !accounts[index]) {
          throw new Error(`Account index out of range in "${value}"`);
        }
        return accounts[index];
      }
      case 'contract': {
        const found = contracts.find((c) => c.name === arg);
        if (!found) {
          throw new Error(`Contract "${arg}" is not part of this challenge`);
        }
        return found.address;
      }
      case 'ether':
        return web3.utils.toWei(arg, 'ether');
      default:
        throw new Error(`Unknown reference "${value}"`);
    }
  };

  return resolve;
}

module.exports = { createResolver };
