'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertCanViewMessage } = require('../../src/utils/message-access');

const publicMsg = { recipient_id: null, sender_id: 10 };
const privateMsg = { recipient_id: 20, sender_id: 10 };

test('public message: anonymous caller allowed', () => {
  assert.equal(assertCanViewMessage(publicMsg, undefined), null);
});

test('public message: logged-in caller allowed', () => {
  assert.equal(assertCanViewMessage(publicMsg, { userId: 99 }), null);
});

test('private message: sender allowed', () => {
  assert.equal(assertCanViewMessage(privateMsg, { userId: 10 }), null);
});

test('private message: recipient allowed', () => {
  assert.equal(assertCanViewMessage(privateMsg, { userId: 20 }), null);
});

test('private message: anonymous denied', () => {
  const r = assertCanViewMessage(privateMsg, undefined);
  assert.equal(r.code, 403);
  assert.equal(r.body.error, 'Access denied');
});

test('private message: stranger denied', () => {
  const r = assertCanViewMessage(privateMsg, { userId: 99 });
  assert.equal(r.code, 403);
});

test('private message: user object without userId treated as anonymous', () => {
  const r = assertCanViewMessage(privateMsg, {});
  assert.equal(r.code, 403);
});
