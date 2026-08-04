'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');

test('生产保护开关启用后，数据库挂载缺失时拒绝创建空库', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ysm-required-db-'));
  const filename = path.join(root, 'missing', 'equipment.db');
  const previous = process.env.YSM_REQUIRE_EXISTING_DB;
  process.env.YSM_REQUIRE_EXISTING_DB = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.YSM_REQUIRE_EXISTING_DB;
    else process.env.YSM_REQUIRE_EXISTING_DB = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.throws(() => openDatabase(filename), /拒绝创建空库/);
  assert.equal(fs.existsSync(filename), false);
  assert.equal(fs.existsSync(path.dirname(filename)), false);
});
