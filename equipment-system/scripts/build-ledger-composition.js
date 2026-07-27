'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { openDatabase } = require('../src/db');
const { EquipmentService, ROLES } = require('../src/service');
const { COMPOSITION_COLUMNS, parseCompositionWorkbook } = require('../src/spreadsheets');

const PROJECT_ROOT = path.join(__dirname, '..');
const ORIGINAL_PATH = path.join(PROJECT_ROOT, '资料整理', '2026年最新设备台账_原始.xlsx');
const NAMING_PATH = path.join(PROJECT_ROOT, '资料整理', '2026年最新设备台账_设备命名建议.xlsx');
const OUTPUT_PATH = path.join(PROJECT_ROOT, '资料整理', '2026年设备产线组合_系统导入.xlsx');
const SHOULD_COMMIT = process.argv.includes('--commit');

const WORKSHOP_CODES = {
  SPC车间: 'YSM-WS-SPC',
  UV车间: 'YSM-WS-UV',
  开槽车间: 'YSM-WS-GRV',
  仓库: 'YSM-WS-WH',
  能耗: 'YSM-WS-ENE',
  设备部: 'YSM-WS-EQP',
};

const WORKSHOP_SHORT_CODES = {
  SPC车间: 'SPC',
  UV车间: 'UV',
  开槽车间: 'GRV',
  仓库: 'WH',
  能耗: 'ENE',
  设备部: 'EQP',
};

function cellText(cell) {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('').trim();
  }
  return String(value).trim();
}

function headerMap(sheet, rowNumber) {
  const result = new Map();
  sheet.getRow(rowNumber).eachCell((cell, index) => result.set(cellText(cell), index));
  return result;
}

function readByHeader(row, headers, name) {
  const index = headers.get(name);
  return index ? cellText(row.getCell(index)) : '';
}

function normalizeLineName(value) {
  return String(value || '')
    .replace(/供挤/g, '共挤')
    .replace(/8000[/／]2500/g, '800/2500')
    .replace(/\s+/g, ' ')
    .trim();
}

function applySheetStyle(sheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: sheet.getRow(1).getCell(sheet.columnCount).address };
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B4D' } };
  sheet.eachRow((row) => { row.alignment = { vertical: 'middle', wrapText: true }; });
}

async function loadRows() {
  if (!fs.existsSync(ORIGINAL_PATH) || !fs.existsSync(NAMING_PATH)) {
    throw new Error('缺少原始台账或设备命名建议文件');
  }
  const originalBook = new ExcelJS.Workbook();
  const namingBook = new ExcelJS.Workbook();
  await Promise.all([originalBook.xlsx.readFile(ORIGINAL_PATH), namingBook.xlsx.readFile(NAMING_PATH)]);
  const original = originalBook.worksheets[0];
  const naming = namingBook.getWorksheet('设备命名建议');
  if (!original || !naming) throw new Error('工作簿结构不正确');
  const namingHeaders = headerMap(naming, 2);
  const originalRows = [];
  for (let rowNumber = 3; rowNumber <= original.rowCount; rowNumber += 1) {
    const row = original.getRow(rowNumber);
    const values = row.values.slice(1).map((value) => {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value ?? '').trim();
    });
    if (values.slice(1).some(Boolean)) originalRows.push({
      row_number: rowNumber,
      sequence: values[0] || '',
      original_name: values[1] || '',
      legacy_code: values[2] || '',
      commissioned_on: values[3] || '',
      maker: values[4] || '',
      area: values[5] || '',
      line: values[6] || '',
    });
  }

  const namingRows = [];
  for (let rowNumber = 3; rowNumber <= naming.rowCount; rowNumber += 1) {
    const row = naming.getRow(rowNumber);
    const originalName = readByHeader(row, namingHeaders, '原设备名称');
    if (!originalName) continue;
    namingRows.push({
      row_number: rowNumber,
      sequence: readByHeader(row, namingHeaders, '序号'),
      original_name: originalName,
      standard_name: readByHeader(row, namingHeaders, '标准设备名称'),
      type_code: readByHeader(row, namingHeaders, '类型代码'),
      key_spec: readByHeader(row, namingHeaders, '关键规格'),
      suggested_code: readByHeader(row, namingHeaders, '建议永久设备编码'),
      review_status: readByHeader(row, namingHeaders, '核查状态'),
      review_note: readByHeader(row, namingHeaders, '核查备注'),
      legacy_code: readByHeader(row, namingHeaders, '原设备编号'),
      commissioned_on: readByHeader(row, namingHeaders, '购买时间').slice(0, 10),
      maker: readByHeader(row, namingHeaders, '设备厂家'),
      area: readByHeader(row, namingHeaders, '区域'),
      line: readByHeader(row, namingHeaders, '生产线'),
    });
  }
  if (originalRows.length !== namingRows.length) {
    throw new Error(`原始台账${originalRows.length}行，命名建议${namingRows.length}行，数量不一致`);
  }
  for (let index = 0; index < originalRows.length; index += 1) {
    const originalRow = originalRows[index];
    const namingRow = namingRows[index];
    for (const key of ['original_name', 'legacy_code', 'area', 'line']) {
      if (String(originalRow[key]).trim() !== String(namingRow[key]).trim()) {
        throw new Error(`第${namingRow.row_number}行${key}与原始台账不一致`);
      }
    }
    namingRow.commissioned_on ||= originalRow.commissioned_on;
  }
  return namingRows;
}

function buildCompositionRows(sourceRows) {
  const eligible = sourceRows.filter((row) =>
    row.review_status !== '待核实' && row.standard_name && row.type_code && row.area && row.line);
  const excluded = sourceRows.filter((row) => !eligible.includes(row));
  const lineCodes = new Map();
  const lineCounters = new Map();
  const positionCounters = new Map();

  const rows = eligible.map((source, index) => {
    const area = source.area.trim();
    const lineName = normalizeLineName(source.line);
    const workshopCode = WORKSHOP_CODES[area];
    const shortCode = WORKSHOP_SHORT_CODES[area];
    if (!workshopCode || !shortCode) throw new Error(`未配置区域“${area}”的车间代码`);
    const lineKey = `${area}|${lineName}`;
    if (!lineCodes.has(lineKey)) {
      const next = (lineCounters.get(area) || 0) + 1;
      lineCounters.set(area, next);
      lineCodes.set(lineKey, `YSM-${shortCode}-L${String(next).padStart(2, '0')}`);
    }
    const lineCode = lineCodes.get(lineKey);
    const positionSequence = (positionCounters.get(lineKey) || 0) + 1;
    positionCounters.set(lineKey, positionSequence);
    const processCode = `${lineCode}-EQ`;
    return {
      row_number: index + 2,
      workshop_code: workshopCode,
      workshop_name: area,
      line_code: lineCode,
      line_name: lineName,
      supervisor: '',
      process_code: processCode,
      process_name: '设备组合（台账初始化）',
      process_sequence: 1,
      position_code: `${processCode}-P${String(positionSequence).padStart(2, '0')}`,
      position_name: `${String(positionSequence).padStart(2, '0')} · ${source.original_name}`,
      position_sequence: positionSequence,
      position_critical: '否',
      equipment_code: '',
      legacy_code: source.legacy_code,
      equipment_name: source.standard_name,
      equipment_alias: source.original_name,
      equipment_category: source.standard_name,
      equipment_type_code: source.type_code,
      key_spec: source.key_spec,
      brand: source.maker,
      model: '',
      serial_number: '',
      responsible_person: '',
      commissioned_on: source.commissioned_on,
      equipment_critical: '否',
      effective_at: '',
      notes: [
        `来源：原始台账第${source.row_number}行`,
        `核查状态：${source.review_status}`,
        source.review_note,
        source.suggested_code && `命名建议码：${source.suggested_code}`,
      ].filter(Boolean).join('；'),
    };
  });
  return { rows, excluded, lineCount: lineCodes.size, workshopCount: new Set(rows.map((row) => row.workshop_code)).size };
}

async function writeWorkbook(rows, excluded) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '优胜美设备管理系统';
  workbook.title = '2026年设备产线组合系统导入';
  const sheet = workbook.addWorksheet('填写模板');
  sheet.columns = COMPOSITION_COLUMNS.map(([key, header, width]) => ({ key, header, width }));
  rows.forEach((row) => sheet.addRow(row));
  applySheetStyle(sheet);

  const excludedSheet = workbook.addWorksheet('待核实未导入');
  excludedSheet.columns = [
    { key: 'sequence', header: '序号', width: 10 },
    { key: 'original_name', header: '原设备名称', width: 28 },
    { key: 'standard_name', header: '标准设备名称', width: 24 },
    { key: 'review_status', header: '核查状态', width: 14 },
    { key: 'review_note', header: '核查备注', width: 60 },
    { key: 'legacy_code', header: '原设备编号', width: 20 },
    { key: 'area', header: '区域', width: 16 },
    { key: 'line', header: '生产线', width: 26 },
  ];
  excluded.forEach((row) => excludedSheet.addRow(row));
  applySheetStyle(excludedSheet);

  const explanation = workbook.addWorksheet('生成说明');
  explanation.columns = [{ width: 24 }, { width: 90 }];
  [
    ['项目', '说明'],
    ['数据来源', '逐行对照原始设备台账与设备命名建议表。'],
    ['建模方式', '原表没有工序和机位，因此每条原生产线先建立一个“设备组合（台账初始化）”工序，机位按原表顺序生成。'],
    ['待核实项', '不创建设备、不建立安装关系，保留在“待核实未导入”工作表，核实后再补录。'],
    ['名称修正', '已确认“供挤→共挤”“8000/2500→800/2500”的生产线文字修正。'],
    ['永久编码', '命名建议码仅保留在备注中；正式永久码由系统按类型、关键规格和当前分组流水生成。'],
  ].forEach((row) => explanation.addRow(row));
  applySheetStyle(explanation);
  await workbook.xlsx.writeFile(OUTPUT_PATH);
}

async function main() {
  const sourceRows = await loadRows();
  const result = buildCompositionRows(sourceRows);
  await writeWorkbook(result.rows, result.excluded);
  const buffer = fs.readFileSync(OUTPUT_PATH);
  const parsedRows = await parseCompositionWorkbook(buffer);
  const db = openDatabase();
  const service = new EquipmentService(db);
  try {
    const preview = service.previewCompositionImport(parsedRows);
    console.log(JSON.stringify({
      source_rows: sourceRows.length,
      import_rows: result.rows.length,
      excluded_rows: result.excluded.length,
      source_workshops: result.workshopCount,
      source_lines: result.lineCount,
      preview: preview.summary,
      output: OUTPUT_PATH,
    }, null, 2));
    if (preview.summary.errors) {
      for (const row of preview.rows.filter((item) => item.errors.length).slice(0, 30)) {
        console.error(`第${row.row_number}行：${row.errors.join('；')}`);
      }
      throw new Error(`组合预览仍有${preview.summary.errors}个错误，未执行导入`);
    }
    if (SHOULD_COMMIT) {
      const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
      const committed = service.commitCompositionImport(parsedRows, {
        filename: path.basename(OUTPUT_PATH),
        file_hash: fileHash,
      }, { actor: '设备台账初始化', role: ROLES.EQUIPMENT_ADMIN });
      console.log(JSON.stringify({ committed }, null, 2));
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
