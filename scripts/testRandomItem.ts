import assert from 'node:assert/strict'

import { pickRandomItem } from '../src/utils/randomItem.ts'

assert.equal(pickRandomItem([], undefined, () => 0), undefined)
assert.equal(pickRandomItem(['only'], 'only', () => 0), 'only')
assert.equal(pickRandomItem(['A', 'B', 'C'], 'B', () => 0), 'A')
assert.equal(pickRandomItem(['A', 'B', 'C'], 'B', () => 0.99), 'C')
assert.equal(pickRandomItem(['A', 'B'], undefined, () => 1), 'B')

console.log('Random key picker checks passed.')
