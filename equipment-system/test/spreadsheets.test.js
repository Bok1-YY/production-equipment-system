'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const {
  compositionTemplateBuffer,
  equipmentTemplateBuffer,
  parseCompositionWorkbook,
  parseEquipmentWorkbook,
} = require('../src/spreadsheets');
const { openDatabase } = require('../src/db');
const { EquipmentService } = require('../src/service');

const namingWorkbookPath = path.resolve(
  __dirname,
  '../资料整理/2026年最新设备台账_设备命名建议.xlsx',
);

test('设备台账XLSX模板可下载并被同一导入器读取', async () => {
  const buffer = await equipmentTemplateBuffer();
  assert.ok(buffer.length > 1000);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const headers = workbook.getWorksheet('填写模板').getRow(1).values;
  assert.ok(headers.includes('类型代码*'));
  assert.ok(headers.includes('关键规格'));
  await assert.rejects(() => parseEquipmentWorkbook(buffer), /没有可导入的设备数据/);
});

test('产线组合XLSX模板包含填写页和说明页，并可直接预览', async () => {
  const buffer = await compositionTemplateBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['填写模板', '字段说明', '允许值']);
  const rows = await parseCompositionWorkbook(buffer);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].position_code, 'YSM-L01-EX-P01');
  assert.equal(rows[1].equipment_name, '');
});

test('现场设备命名建议表可由台账导入器直接读取并识别待核实行', {
  skip: !fs.existsSync(namingWorkbookPath) && '本地真实台账未纳入公开仓库',
}, async () => {
  const rows = await parseEquipmentWorkbook(fs.readFileSync(namingWorkbookPath));
  assert.equal(rows.length, 218);
  assert.ok(rows.some((row) => row.review_status === '待核实'));
  assert.ok(rows.some((row) => row.type_code === 'MIX' && row.key_spec === 'H800-C2500'));
  const db = openDatabase(':memory:');
  const preview = new EquipmentService(db).previewEquipmentImport(rows);
  assert.equal(preview.summary.rows, 218);
  assert.ok(preview.summary.errors > 0, '待核实和未编号记录必须阻止当前版本整批导入');
  assert.ok(preview.rows.some((row) => row.errors.some((message) => message.includes('待核实'))));
  db.close();
});
