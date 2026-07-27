'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractScanToken } = require('../web/scanner-utils');

const TOKEN = '-5W4LTV9X3hIMnvs';

test('手机扫码可从铭牌完整网址中提取永久令牌', () => {
  assert.equal(extractScanToken(`http://192.168.5.100:8788/?scan=${TOKEN}`), TOKEN);
  assert.equal(extractScanToken(`https://old-server.example/path?from=label&scan=${TOKEN}#top`), TOKEN);
  assert.equal(extractScanToken(`?scan=${TOKEN}`), TOKEN);
});

test('手机扫码兼容扫描器直接返回的永久令牌', () => {
  assert.equal(extractScanToken(TOKEN), TOKEN);
  assert.equal(extractScanToken(` \n${TOKEN}\t`), TOKEN);
});

test('手机扫码拒绝任意网址和伪造令牌', () => {
  for (const value of [
    '',
    'https://example.com/',
    '/equipment/123',
    '?equipment=123',
    'too-short',
    '123456789012345!',
    `https://example.com/?scan=${TOKEN}extra`,
  ]) {
    assert.throws(() => extractScanToken(value), /不是有效的优胜美设备铭牌二维码/);
  }
});
