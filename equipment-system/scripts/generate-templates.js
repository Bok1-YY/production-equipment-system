'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { equipmentTemplateBuffer, compositionTemplateBuffer } = require('../src/spreadsheets');

(async () => {
  const target = path.join(__dirname, '..', '导入模板');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, '01_设备台账导入模板.xlsx'), await equipmentTemplateBuffer());
  fs.writeFileSync(path.join(target, '02_产线组合初始化模板.xlsx'), await compositionTemplateBuffer());
  console.log(`模板已生成：${target}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
