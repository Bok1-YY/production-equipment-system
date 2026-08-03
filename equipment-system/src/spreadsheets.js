'use strict';

const ExcelJS = require('exceljs');
const { DomainError } = require('./domain');

const EQUIPMENT_COLUMNS = [
  ['standard_name', '标准设备名称*', 20], ['type_code', '类型代码*', 12], ['key_spec', '关键规格', 18],
  ['alias', '现场别名', 18], ['category', '设备类别*', 16],
  ['brand', '品牌', 14], ['model', '型号', 16], ['serial_number', '出厂编号', 18],
  ['responsible_person', '负责人', 12], ['commissioned_on', '启用日期', 14], ['legacy_code', '原资产编号', 18],
  ['data_source', '数据来源', 14], ['critical', '关键设备', 12], ['verified', '资料已核实', 12], ['notes', '备注', 28],
];

const COMPOSITION_COLUMNS = [
  ['workshop_code', '车间编码*', 16], ['workshop_name', '车间名称*', 16],
  ['line_code', '产线编码*', 16], ['line_name', '产线名称*', 18], ['supervisor', '生产主管', 12],
  ['process_code', '工序编码*', 18], ['process_name', '工序名称*', 18], ['process_sequence', '工序顺序', 10],
  ['position_code', '机位编码*', 20], ['position_name', '机位名称*', 18], ['position_sequence', '机位顺序', 10], ['position_critical', '关键机位', 10],
  ['equipment_code', '设备永久编码', 18], ['legacy_code', '原资产编号', 18],
  ['equipment_name', '设备名称', 18], ['equipment_alias', '设备别名', 16], ['equipment_category', '设备类别', 16],
  ['equipment_type_code', '设备类型代码', 14], ['key_spec', '设备关键规格', 18],
  ['brand', '品牌', 14], ['model', '型号', 16], ['serial_number', '出厂编号', 18],
  ['responsible_person', '设备负责人', 12], ['commissioned_on', '购置/启用日期', 14], ['equipment_critical', '关键设备', 10],
  ['effective_at', '安装生效时间', 20], ['notes', '备注', 28],
];

function columnLetter(number) {
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function applyWorkbookStyle(workbook, sheet, columns, title) {
  sheet.columns = columns.map(([key, header, width]) => ({ key, header, width }));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: `${columnLetter(columns.length)}1` };
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B4D' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.eachRow((row) => { row.alignment = { vertical: 'middle', wrapText: true }; });
  workbook.creator = '优胜美设备管理系统';
  workbook.title = title;
  workbook.created = new Date();
}

function addInstructions(workbook, rows) {
  const sheet = workbook.addWorksheet('字段说明');
  sheet.columns = [{ header: '字段', key: 'field', width: 24 }, { header: '填写说明', key: 'description', width: 72 }];
  rows.forEach((row) => sheet.addRow(row));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B4D' } };
  sheet.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });
}

function addAllowedValues(workbook) {
  const sheet = workbook.addWorksheet('允许值');
  sheet.addRow(['布尔字段', '设备状态', '说明']);
  sheet.addRow(['是', 'ACTIVE', '关键设备、关键机位、资料已核实填写“是”或“否”']);
  sheet.addRow(['否', 'IDLE', '设备状态由系统管理，初始化模板无需填写']);
  sheet.addRow(['', 'DISABLED', '']);
  sheet.addRow(['', 'RETIRED', '']);
  sheet.columns = [{ width: 16 }, { width: 16 }, { width: 60 }];
  sheet.getRow(1).font = { bold: true };
}

async function equipmentTemplateBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('填写模板');
  applyWorkbookStyle(workbook, sheet, EQUIPMENT_COLUMNS, '设备台账导入模板');
  sheet.addRow({
    standard_name: '挤出主机', type_code: 'EXT', key_spec: '135', alias: '1号主挤出机', category: '生产主机', brand: '示例品牌',
    model: '示例型号', serial_number: 'SN-EXAMPLE', responsible_person: '张三', commissioned_on: '2026-01-01',
    legacy_code: 'OLD-001', data_source: '现场盘点', critical: '是', verified: '否', notes: '请删除示例行后填写真实设备',
  });
  sheet.getRow(2).font = { italic: true, color: { argb: 'FF777777' } };
  addInstructions(workbook, [
    { field: '标准设备名称、类型代码、设备类别', description: '必填。永久设备编码由系统按类型代码和关键规格自动分配。' },
    { field: '关键规格', description: '可留空；只能使用大写字母、数字和连字符，例如135、H800-C2500、R5。' },
    { field: '原资产编号、品牌、出厂编号', description: '用于严格识别和去重，请尽量填写。' },
    { field: '关键设备、资料已核实', description: '只能填写“是”或“否”。' },
    { field: '启用日期', description: '使用YYYY-MM-DD格式。' },
  ]);
  addAllowedValues(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function compositionTemplateBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('填写模板');
  applyWorkbookStyle(workbook, sheet, COMPOSITION_COLUMNS, '产线组合初始化模板');
  sheet.addRow({
    workshop_code: 'YSM-WS01', workshop_name: '生产车间', line_code: 'YSM-L01', line_name: '一号产线', supervisor: '生产主管',
    process_code: 'YSM-L01-EX', process_name: '挤出工序', process_sequence: 1,
    position_code: 'YSM-L01-EX-P01', position_name: '主挤出机位', position_sequence: 1, position_critical: '是',
    equipment_code: '', legacy_code: 'OLD-001', equipment_name: '单螺杆挤出机', equipment_alias: '1号主挤出机',
    equipment_category: '生产主机', equipment_type_code: 'EXT', key_spec: '135',
    brand: '示例品牌', model: '示例型号', serial_number: 'SN-EXAMPLE',
    responsible_person: '张三', commissioned_on: '2026-01-01', equipment_critical: '是', effective_at: '2026-07-01 08:00', notes: '请删除示例行后填写真实组合',
  });
  sheet.addRow({
    workshop_code: 'YSM-WS01', workshop_name: '生产车间', line_code: 'YSM-L01', line_name: '一号产线', supervisor: '生产主管',
    process_code: 'YSM-L01-EX', process_name: '挤出工序', process_sequence: 1,
    position_code: 'YSM-L01-EX-P02', position_name: '备用机位', position_sequence: 2, position_critical: '否', notes: '设备字段留空表示只创建空机位',
  });
  sheet.getRow(2).font = { italic: true, color: { argb: 'FF777777' } };
  sheet.getRow(3).font = { italic: true, color: { argb: 'FF777777' } };
  addInstructions(workbook, [
    { field: '一行代表一个机位', description: '相同产线和工序信息在每一行重复填写，便于从旧Excel复制整理。' },
    { field: '带*字段', description: '必须填写。编码全厂唯一，已有编码会复用，名称或上下级不一致会报错。' },
    { field: '设备匹配顺序', description: '设备永久编码 → 原资产编号 → 品牌＋出厂编号；不按名称模糊匹配。' },
    { field: '自动创建设备', description: '找不到现有设备时，必须填写设备名称、设备类别和设备类型代码，系统按类型与规格自动生成永久码。' },
    { field: '购置/启用日期', description: '可留空；使用YYYY-MM-DD格式。' },
    { field: '空机位', description: '设备相关字段全部留空时只创建结构，不安装设备。' },
    { field: '安装生效时间', description: '可留空，默认使用导入确认时间；建议格式YYYY-MM-DD HH:mm。' },
  ]);
  addAllowedValues(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function cellValue(cell) {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (Array.isArray(value.richText)) return value.richText.map((x) => x.text).join('').trim();
  }
  return String(value).trim();
}

async function parseCompositionWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new DomainError('Excel文件内容为空', 400);
  if (buffer.length > 8 * 1024 * 1024) throw new DomainError('Excel文件不能超过8MB', 413);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch { throw new DomainError('无法读取Excel文件，请确认文件是有效的XLSX格式', 400); }
  const sheet = workbook.getWorksheet('填写模板') || workbook.worksheets[0];
  if (!sheet) throw new DomainError('Excel中没有工作表', 400);
  const headerIndex = new Map();
  sheet.getRow(1).eachCell((cell, col) => headerIndex.set(cellValue(cell).replace(/\*/g, ''), col));
  const missing = COMPOSITION_COLUMNS.filter(([, header]) => header.endsWith('*') && !headerIndex.has(header.replace('*', ''))).map(([, header]) => header);
  if (missing.length) throw new DomainError(`模板缺少必填列：${missing.join('、')}`, 400);
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const record = { row_number: rowNumber };
    let hasValue = false;
    for (const [key, header] of COMPOSITION_COLUMNS) {
      const col = headerIndex.get(header.replace('*', ''));
      record[key] = col ? cellValue(row.getCell(col)) : '';
      if (record[key]) hasValue = true;
    }
    if (hasValue) rows.push(record);
  }
  if (!rows.length) throw new DomainError('Excel中没有可导入的数据行', 400);
  if (rows.length > 1000) throw new DomainError('单次最多导入1000行组合数据', 400);
  return rows;
}

async function parseEquipmentWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new DomainError('Excel文件内容为空', 400);
  if (buffer.length > 8 * 1024 * 1024) throw new DomainError('Excel文件不能超过8MB', 413);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch { throw new DomainError('无法读取Excel文件，请确认文件是有效的XLSX格式', 400); }
  const namingSheet = workbook.getWorksheet('设备命名建议');
  const sheet = namingSheet || workbook.getWorksheet('填写模板') || workbook.worksheets[0];
  if (!sheet) throw new DomainError('Excel中没有工作表', 400);
  if (namingSheet) return parseNamingSuggestionSheet(namingSheet);
  const headerIndex = new Map();
  sheet.getRow(1).eachCell((cell, col) => headerIndex.set(cellValue(cell).replace(/\*/g, ''), col));
  for (const required of ['标准设备名称', '类型代码', '设备类别']) {
    if (!headerIndex.has(required)) throw new DomainError(`模板缺少必填列：${required}`, 400);
  }
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const record = {};
    let hasValue = false;
    for (const [key, header] of EQUIPMENT_COLUMNS) {
      const col = headerIndex.get(header.replace('*', ''));
      record[key] = col ? cellValue(row.getCell(col)) : '';
      if (record[key]) hasValue = true;
    }
    if (hasValue) {
      if (record.notes.includes('请删除示例行') || record.legacy_code === 'OLD-001') continue;
      record.critical = ['1', '是', 'true', 'TRUE'].includes(record.critical);
      record.verified = ['1', '是', 'true', 'TRUE'].includes(record.verified);
      rows.push(record);
    }
  }
  if (!rows.length) throw new DomainError('Excel中没有可导入的设备数据', 400);
  if (rows.length > 500) throw new DomainError('单次最多导入500台设备', 400);
  return rows;
}

function parseNamingSuggestionSheet(sheet) {
  const headerIndex = new Map();
  sheet.getRow(2).eachCell((cell, col) => headerIndex.set(cellValue(cell).replace(/\*/g, ''), col));
  for (const required of ['标准设备名称', '类型代码', '关键规格', '核查状态', '原设备编号']) {
    if (!headerIndex.has(required)) throw new DomainError(`命名建议工作表缺少列：${required}`, 400);
  }
  const get = (row, header) => {
    const col = headerIndex.get(header);
    return col ? cellValue(row.getCell(col)) : '';
  };
  const rows = [];
  for (let rowNumber = 3; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const standardName = get(row, '标准设备名称');
    const originalName = get(row, '原设备名称');
    if (!standardName && !originalName) continue;
    rows.push({
      row_number: rowNumber,
      standard_name: standardName,
      type_code: get(row, '类型代码'),
      key_spec: get(row, '关键规格'),
      suggested_code: get(row, '建议永久设备编码'),
      review_status: get(row, '核查状态'),
      alias: originalName,
      category: standardName,
      brand: get(row, '设备厂家'),
      commissioned_on: get(row, '购买时间').slice(0, 10),
      legacy_code: get(row, '原设备编号'),
      data_source: '2026年设备台账命名整理',
      critical: false,
      verified: false,
      notes: [get(row, '核查备注'), get(row, '区域') && `原区域：${get(row, '区域')}`, get(row, '生产线') && `原生产线：${get(row, '生产线')}`].filter(Boolean).join('；'),
    });
  }
  if (!rows.length) throw new DomainError('命名建议工作表中没有可导入的设备数据', 400);
  if (rows.length > 500) throw new DomainError('单次最多导入500台设备', 400);
  return rows;
}

async function compositionExportBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('当前组合');
  applyWorkbookStyle(workbook, sheet, COMPOSITION_COLUMNS, '当前产线组合');
  rows.forEach((row) => sheet.addRow(row));
  addInstructions(workbook, [{ field: '说明', description: '该文件按产线组合初始化模板列结构导出，可整理后重新导入。正式运行后的单台移动仍应走设备变动审核。' }]);
  addAllowedValues(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function operationalReportBuffer(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '优胜美生产设备系统';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('汇总');
  summary.columns = [
    { header: '指标', key: 'metric', width: 28 },
    { header: '数值', key: 'value', width: 18 },
  ];
  summary.addRows([
    { metric: '开始时间', value: report.range.start },
    { metric: '结束时间', value: report.range.end },
    { metric: '报修工单数', value: Number(report.totals.work_orders || 0) },
    { metric: '已完成工单数', value: Number(report.totals.completed || 0) },
    { metric: '停机工单数', value: Number(report.totals.downtime_orders || 0) },
    { metric: '平均响应分钟', value: report.totals.avg_response_minutes },
    { metric: '平均维修分钟', value: report.totals.avg_repair_minutes },
    { metric: '停机分钟合计', value: Number(report.totals.downtime_minutes || 0) },
    { metric: '重复报修数', value: Number(report.totals.repeat_repairs || 0) },
  ]);

  const addSheet = (name, columns, rows) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: `${columnLetter(columns.length)}1` };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    rows.forEach((row) => sheet.addRow(row));
  };
  addSheet('产线故障排行', [
    { header: '产线编码', key: 'line_code', width: 18 },
    { header: '产线名称', key: 'line_name', width: 22 },
    { header: '故障次数', key: 'fault_count', width: 12 },
    { header: '停机分钟', key: 'downtime_minutes', width: 14 },
  ], report.lines);
  addSheet('故障类别排行', [
    { header: '故障类别', key: 'category', width: 22 },
    { header: '故障次数', key: 'fault_count', width: 12 },
    { header: '停机分钟', key: 'downtime_minutes', width: 14 },
  ], report.fault_categories);
  addSheet('设备故障排行', [
    { header: '设备编码', key: 'code', width: 20 },
    { header: '设备名称', key: 'standard_name', width: 24 },
    { header: '发生时产线编码', key: 'line_code', width: 18 },
    { header: '发生时产线名称', key: 'line_name', width: 22 },
    { header: '故障次数', key: 'fault_count', width: 12 },
    { header: '停机分钟', key: 'downtime_minutes', width: 14 },
  ], report.equipment);
  addSheet('技术员绩效', [
    { header: '技术员', key: 'technician', width: 18 },
    { header: '接单数', key: 'assigned_count', width: 12 },
    { header: '完成数', key: 'completed_count', width: 12 },
    { header: '平均维修分钟', key: 'avg_repair_minutes', width: 16 },
  ], report.technicians);
  addSheet('点检保养达成', [
    { header: '任务类型', key: 'task_kind', width: 16 },
    { header: '应执行', key: 'due_count', width: 12 },
    { header: '已执行', key: 'executed_count', width: 12 },
    { header: '异常', key: 'abnormal_count', width: 12 },
    { header: '逾期', key: 'overdue_count', width: 12 },
  ], report.tasks);
  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  COMPOSITION_COLUMNS,
  EQUIPMENT_COLUMNS,
  compositionExportBuffer,
  compositionTemplateBuffer,
  equipmentTemplateBuffer,
  operationalReportBuffer,
  parseCompositionWorkbook,
  parseEquipmentWorkbook,
};
