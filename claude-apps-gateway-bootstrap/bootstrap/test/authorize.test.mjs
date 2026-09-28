// Entitlement-gate tests for the bootstrap resource server (node:test, no
// dependencies — run with `npm test`). Covers every branch of isEntitled():
// the ungated default, group and role gates individually, both together, and
// the deny-by-default behavior when a required claim is absent from the token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEntitled, parseList } from '../authorize.js';

const G = '11111111-2222-3333-4444-555555555555'; // an Entra group object id

test('parseList: splits, trims, and drops empties', () => {
  assert.deepEqual(parseList(' a, b ,,c '), ['a', 'b', 'c']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
});

test('ungated: every authenticated caller is entitled', () => {
  assert.equal(isEntitled({ groups: [G] }, [], []), true);
  assert.equal(isEntitled({}, [], []), true);
});

test('group gate: member allowed, non-member and missing-claim refused', () => {
  assert.equal(isEntitled({ groups: [G, 'other'] }, [G], []), true);
  assert.equal(isEntitled({ groups: ['other'] }, [G], []), false);
  assert.equal(isEntitled({}, [G], []), false); // claim absent -> deny, never fail open
  assert.equal(isEntitled({ groups: G }, [G], []), true); // scalar claim tolerated
});

test('role gate: matching role allowed, wrong or missing refused', () => {
  assert.equal(isEntitled({ roles: ['bootstrap-user'] }, [], ['bootstrap-user']), true);
  assert.equal(isEntitled({ roles: ['other'] }, [], ['bootstrap-user']), false);
  assert.equal(isEntitled({}, [], ['bootstrap-user']), false);
});

test('both gates: AND across dimensions, OR within each', () => {
  const req = [[G], ['bootstrap-user']];
  assert.equal(isEntitled({ groups: [G], roles: ['bootstrap-user'] }, ...req), true);
  assert.equal(isEntitled({ groups: [G] }, ...req), false);
  assert.equal(isEntitled({ roles: ['bootstrap-user'] }, ...req), false);
});

test('configurable groups claim: Cognito cognito:groups is honored', () => {
  // Amazon Cognito emits group membership in `cognito:groups`, not `groups`.
  // The 4th arg selects the claim so the same gate works across IdPs.
  const cognito = { 'cognito:groups': ['engineering'], sub: 'u1' };
  assert.equal(isEntitled(cognito, ['engineering'], [], 'cognito:groups'), true);
  assert.equal(isEntitled(cognito, ['business'], [], 'cognito:groups'), false);
  // With the default 'groups' claim, a Cognito token would NOT match (claim absent).
  assert.equal(isEntitled(cognito, ['engineering'], []), false);
  // Default still works for Entra-style `groups`.
  assert.equal(isEntitled({ groups: [G] }, [G], []), true);
});
