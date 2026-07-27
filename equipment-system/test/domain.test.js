'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DomainError,
  assertWorkOrderTransition,
  formatEquipmentCode,
  isValidEquipmentCode,
} = require('../src/domain');

test('永久设备编码按类型和规格使用四位分组流水', () => {
  assert.equal(formatEquipmentCode('EXT', '135', 1), 'YSM-EXT-135-0001');
  assert.equal(formatEquipmentCode('MIX', 'H800-C2500', 9), 'YSM-MIX-H800-C2500-0009');
  assert.equal(formatEquipmentCode('PUL', '', 9999), 'YSM-PUL-9999');
  assert.equal(isValidEquipmentCode('YSM-EXT-135-0001'), true);
  assert.equal(isValidEquipmentCode('YSM-EQ-000123'), true);
  assert.equal(isValidEquipmentCode('YSM-L01-EQ01'), false);
});

test('设备编码流水号越界时拒绝生成', () => {
  assert.throws(() => formatEquipmentCode('EXT', '135', 0), DomainError);
  assert.throws(() => formatEquipmentCode('EXT', '135', 10000), DomainError);
  assert.throws(() => formatEquipmentCode('EXT', '1.3M', 1), DomainError);
});

test('维修工单只能按照确定状态机流转', () => {
  assert.doesNotThrow(() => assertWorkOrderTransition('ACCEPTED', 'ARRIVED'));
  assert.doesNotThrow(() => assertWorkOrderTransition('TRIAL_RUN', 'COMPLETED'));
  assert.doesNotThrow(() => assertWorkOrderTransition('PENDING_REVIEW', 'COMPLETED'));
  // 接单不走状态流转，只走 assignWorkOrder：否则界面上会出现一个能造出
  // "已分派但没有负责人"脏工单的选项。
  assert.throws(() => assertWorkOrderTransition('SUBMITTED', 'ACCEPTED'), /不能从/);
  assert.throws(() => assertWorkOrderTransition('SUBMITTED', 'COMPLETED'), /不能从/);
  assert.throws(() => assertWorkOrderTransition('COMPLETED', 'IN_PROGRESS'), /不能从/);
  // 到场之后也要能取消：否则一张误接的垃圾单既撤不了又结不掉（结单要满足三道硬校验）
  assert.doesNotThrow(() => assertWorkOrderTransition('ARRIVED', 'CANCELLED'));
  assert.doesNotThrow(() => assertWorkOrderTransition('IN_PROGRESS', 'CANCELLED'));
});
