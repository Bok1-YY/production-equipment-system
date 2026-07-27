'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const SOURCE = process.argv[2];
const OUTPUT_DIR = path.join(__dirname, '..', '资料整理');
const OUTPUT = path.join(OUTPUT_DIR, '2026年最新设备台账_设备命名建议.xlsx');

const TYPE_NAMES = {
  ABS: '吸水辊机',
  ACP: '空气压缩机',
  AWP: '高空作业车',
  BRU: '毛刷机',
  CAL: '定型台',
  CHL: '冷水机',
  CNV: '输送机',
  COA: '涂布机',
  CRN: '桥式起重机',
  CRS: '破碎机',
  CUR: 'UV固化机',
  DCT: '除尘设备',
  DOS: '配料设备',
  EXC: '准分子处理设备',
  EXT: '挤出机',
  FDR: '集中供料系统',
  FLP: '翻板机',
  FLT: '叉车',
  GBX: '齿轮箱',
  GLU: '涂胶机',
  GRV: '开槽机',
  HTR: '暖风机',
  HVC: '工业空调',
  IMP: '气动冲击扳手',
  LAM: '覆膜机',
  LVL: '流平机',
  MIL: '磨粉机',
  MIX: '混料机',
  MON: '在线监测设备',
  PAL: '自动打托机',
  PKG: '自动包装设备',
  PMP: '水泵',
  PRS: '压力设备',
  PUL: '牵引机',
  ROB: '工业机械手',
  SAW: '锯切设备',
  SLC: '切片机',
  SND: '砂光机',
  STK: '码垛设备',
  TNK: '工艺水槽',
  TRM: '修边机',
  VAC: '集中真空系统',
};

const NON_MACHINE_PATTERNS = [
  [/集中真空$/, '记录名称为集中真空系统，请确认是否整套系统独立建档，或按真空泵拆分。'],
  [/配电房$/, '“配电房”属于场所或系统名称，请核实实际设备是否为变压器、开关柜等。'],
  [/^食堂$/, '“食堂”属于场所，不应直接作为独立设备编码。'],
  [/^淋漆线$/, '整条生产线是否作为一台独立设备需要设备科确认。'],
  [/^大张贴合线$/, '整条生产线是否作为一台独立设备需要设备科确认。'],
  [/机械手、翻板机/, '一行同时包含机械手和翻板机，请确认是组合设备还是应拆成两台独立设备。'],
];

function text(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('').trim();
  }
  return String(value).trim();
}

function compactName(value) {
  return String(value || '').replace(/\s+/g, '').replace(/wpc/gi, 'WPC').replace(/spc/gi, 'SPC');
}

function chineseNumber(value) {
  return { 四: '4', 五: '5', 七: '7' }[value] || value;
}

function classify(originalName, productionLine) {
  const name = compactName(originalName);
  const line = compactName(productionLine);
  let match;

  if ((match = name.match(/(?:SPC|WPC)?混料机$/))) {
    const capacity = line.match(/(\d+)[/／](\d+)/);
    if (capacity) {
      const hotCapacity = capacity[1] === '8000' && capacity[2] === '2500' ? '800' : capacity[1];
      return { standard: '高速混料机', type: 'MIX', spec: `H${hotCapacity}-C${capacity[2]}` };
    }
    return { standard: '高速混料机', type: 'MIX', spec: '' };
  }
  if (/自动上料$/.test(name)) return { standard: '集中供料系统', type: 'FDR', spec: '' };
  if (/冷却水泵$/.test(name)) return { standard: '冷却水泵', type: 'PMP', spec: '' };
  if ((match = name.match(/(?:SPC|WPC)(\d+)(主机|副机)$/))) {
    return { standard: match[2] === '主机' ? '挤出主机' : '挤出副机', type: 'EXT', spec: match[1] };
  }
  if (/覆膜机$/.test(name)) {
    const roller = name.match(/([四五七])辊/);
    const spec = roller ? `R${chineseNumber(roller[1])}` : (/PE静音垫/.test(name) ? 'PE' : '');
    return { standard: /PE静音垫/.test(name) ? '静音垫覆膜机' : '辊式覆膜机', type: 'LAM', spec };
  }
  if (/牵引机$/.test(name)) return { standard: '牵引机', type: 'PUL', spec: '' };
  if (/切片机$/.test(name)) return { standard: '切片机', type: 'SLC', spec: '' };
  if (/齿轮箱$/.test(name)) {
    match = name.match(/(\d+)齿轮箱$/);
    return { standard: '挤出机齿轮箱', type: 'GBX', spec: match?.[1] || '' };
  }
  if (/定型台$/.test(name)) return { standard: '真空定型台', type: 'CAL', spec: '' };
  if (/锯片机$/.test(name)) return { standard: '锯片切割机', type: 'SAW', spec: 'DISC' };
  if (/分切多片锯$/.test(name)) return { standard: '分切多片锯', type: 'SAW', spec: 'MULTI' };
  if (/短边锯$/.test(name)) return { standard: '短边锯', type: 'SAW', spec: 'SHORT' };
  if (/磨粉机$/.test(name)) return { standard: '磨粉机', type: 'MIL', spec: '' };
  if (/破碎机$/.test(name)) return { standard: '破碎机', type: 'CRS', spec: '' };
  if (/行车$/.test(name)) {
    match = name.match(/(\d+)T/);
    return { standard: '桥式起重机', type: 'CRN', spec: match ? `T${match[1]}` : '' };
  }
  if (/集中真空$/.test(name)) return { standard: '集中真空系统', type: 'VAC', spec: '' };
  if (/除尘/.test(name)) {
    let spec = '';
    if (/催化燃烧/.test(name)) spec = 'CAT';
    else if (/磨粉/.test(name)) spec = 'MIL';
    else if (/开槽/.test(name)) spec = 'GRV';
    else if (/修边/.test(name)) spec = 'TRM';
    else if (/二级活性炭/.test(name)) spec = 'C2';
    return { standard: /催化燃烧/.test(name) ? '催化燃烧除尘设备' : '除尘设备', type: 'DCT', spec };
  }
  if (/在线监测设备$/.test(name)) return { standard: '在线监测设备', type: 'MON', spec: '' };
  if (/叉车$/.test(name)) return { standard: /电瓶/.test(name) ? '电动叉车' : '叉车', type: 'FLT', spec: /电瓶/.test(name) ? 'BAT' : '' };
  if (/风炮机$/.test(name)) return { standard: '气动冲击扳手', type: 'IMP', spec: '' };
  if (/空压机$/.test(name)) {
    match = name.match(/(\d+)KW/i);
    return { standard: '空气压缩机', type: 'ACP', spec: match ? `P${match[1]}` : '' };
  }
  if (/配方小料机$/.test(name)) return { standard: '小料配料机', type: 'DOS', spec: '' };
  if (/水冷空调$/.test(name)) return { standard: '水冷工业空调', type: 'HVC', spec: 'WATER' };
  if (/圆弧压机$/.test(name)) return { standard: '圆弧压机', type: 'PRS', spec: 'ARC' };
  if (/冷压机$/.test(name)) return { standard: '冷压机', type: 'PRS', spec: 'COLD' };
  if (/冲床$/.test(name)) return { standard: '冲床', type: 'PRS', spec: 'PUNCH' };
  if (/上料机械手$/.test(name)) {
    match = name.match(/(单|双)工位/);
    return { standard: '上料机械手', type: 'ROB', spec: match ? `${match[1] === '单' ? 'S1' : 'S2'}-LOAD` : 'LOAD' };
  }
  if (/下料机械手$/.test(name)) return { standard: '下料机械手', type: 'ROB', spec: 'UNLOAD' };
  if (/随动机械手$/.test(name)) return { standard: '随动机械手', type: 'ROB', spec: 'FOLLOW' };
  if (/翻板机械手$/.test(name)) return { standard: '翻板机械手', type: 'ROB', spec: 'FLIP' };
  if (/机械手、翻板机$/.test(name)) return { standard: '机械手与翻板机组合', type: 'ROB', spec: 'COMBO' };
  if (/机械手$/.test(name)) return { standard: '工业机械手', type: 'ROB', spec: '' };
  if (/上料翻板机$/.test(name)) return { standard: '上料翻板机', type: 'FLP', spec: 'LOAD' };
  if (/下料翻板机$/.test(name)) return { standard: '下料翻板机', type: 'FLP', spec: 'UNLOAD' };
  if (/翻板机$/.test(name)) return { standard: '翻板机', type: 'FLP', spec: '' };
  if (/冷却水槽$/.test(name)) return { standard: '冷却水槽', type: 'TNK', spec: 'COOL' };
  if (/回火冷热水槽$/.test(name)) return { standard: '回火冷热水槽', type: 'TNK', spec: 'TEMPER' };
  if (/水槽冷水机$/.test(name)) return { standard: '工艺冷水机', type: 'CHL', spec: '' };
  if (/吸水辊机$/.test(name)) return { standard: '吸水辊机', type: 'ABS', spec: '' };
  if (/加热流平机\d*$/.test(name)) return { standard: '加热流平机', type: 'LVL', spec: 'HEAT' };
  if (/底漆涂布机\d*$/.test(name)) return { standard: '底漆涂布机', type: 'COA', spec: 'BASE' };
  if (/面漆涂布机$/.test(name)) return { standard: '面漆涂布机', type: 'COA', spec: 'TOP' };
  if ((match = name.match(/(\d+)灯固化机$/))) return { standard: 'UV固化机', type: 'CUR', spec: `L${match[1]}` };
  if (/准分子设备$/.test(name)) return { standard: '准分子处理设备', type: 'EXC', spec: '' };
  if ((match = name.match(/(\d+)头毛刷机$/))) return { standard: '毛刷清洁机', type: 'BRU', spec: `H${match[1]}` };
  if (/翻板输送机$/.test(name)) return { standard: '翻板输送机', type: 'CNV', spec: 'FLIP' };
  if (/翻板刷灰输送机$/.test(name)) return { standard: '刷灰输送机', type: 'CNV', spec: 'BRUSH' };
  if (/加热输送机$/.test(name)) return { standard: '加热输送机', type: 'CNV', spec: 'HEAT' };
  if (/翻板输送码垛机$/.test(name)) return { standard: '翻板输送码垛机', type: 'STK', spec: 'FLIP' };
  if (/长边开槽机$/.test(name)) return { standard: '长边开槽机', type: 'GRV', spec: 'LONG' };
  if (/短边开槽机$/.test(name)) return { standard: '短边开槽机', type: 'GRV', spec: 'SHORT' };
  if (/长边修边机$/.test(name)) return { standard: '长边修边机', type: 'TRM', spec: 'LONG' };
  if (/短边修边机$/.test(name)) return { standard: '短边修边机', type: 'TRM', spec: 'SHORT' };
  if (/自动包装线$/.test(name)) return { standard: '自动包装设备', type: 'PKG', spec: '' };
  if (/贴胶胶辊机$/.test(name)) return { standard: '胶辊涂胶机', type: 'GLU', spec: '' };
  if (/自动打托机$/.test(name)) return { standard: '自动打托机', type: 'PAL', spec: '' };
  if (/砂光机$/.test(name)) return { standard: '砂光机', type: 'SND', spec: '' };
  if (/蒸汽暖风机$/.test(name)) return { standard: '蒸汽暖风机', type: 'HTR', spec: 'STEAM' };
  if (/电动登高车$/.test(name)) return { standard: '电动高空作业车', type: 'AWP', spec: 'ELEC' };
  if (/淋漆线$/.test(name)) return { standard: '淋漆生产线', type: 'COA', spec: 'LINE' };
  if (/大张贴合线$/.test(name)) return { standard: '大张贴合生产线', type: 'LAM', spec: 'LINE' };
  if (/配电房$/.test(name)) {
    match = name.match(/(\d+)KVA/i);
    return { standard: '配电系统', type: '', spec: match ? `K${match[1]}` : '' };
  }
  if (/^食堂$/.test(name)) return { standard: '食堂', type: '', spec: '' };
  return { standard: '', type: '', spec: '' };
}

function baseReview(row, duplicateCodes) {
  const reasons = [];
  const confirmedCorrections = [];
  const name = compactName(row.name);
  const line = compactName(row.line);
  let blockCode = false;

  for (const [pattern, message] of NON_MACHINE_PATTERNS) {
    if (pattern.test(name)) {
      reasons.push(message);
      blockCode = true;
    }
  }
  if (row.legacyCode && duplicateCodes.has(row.legacyCode.toUpperCase())) reasons.push(`原设备编号${row.legacyCode}在原表中重复。`);
  if (/[a-z]/.test(row.legacyCode)) confirmedCorrections.push('已确认原设备编号中的小写字母应统一为大写。');
  if (!row.sequence) reasons.push('原表序号为空。');
  if (/8000[/／]2500/.test(line)) confirmedCorrections.push('已确认“8000/2500”为录入错误，正确规格为“800/2500”；建议码已按H800-C2500生成。');
  if (/供挤/.test(line)) confirmedCorrections.push('已确认生产线名称中的“供挤”应修正为“共挤”。');
  const nameNo = name.match(/^(\d+)#/);
  const lineNo = line.match(/^(\d+)#/);
  if (nameNo && lineNo && nameNo[1] !== lineNo[1]) reasons.push(`设备名称为${nameNo[1]}号，但生产线填写为${lineNo[1]}号，请核实归属。`);
  if (/^12#SPC随动机械手$/.test(name) && /WPC/i.test(line)) confirmedCorrections.push('已确认设备名称中的“SPC”属于文字混写，应按WPC修正。');

  return { reasons, confirmedCorrections, blockCode };
}

function border() {
  const side = { style: 'thin', color: { argb: 'FFD9E2DD' } };
  return { top: side, left: side, bottom: side, right: side };
}

async function main() {
  if (!SOURCE) {
    throw new Error('用法：node scripts/generate-equipment-naming-workbook.js <源台账.xlsx>');
  }
  if (!fs.existsSync(SOURCE)) throw new Error(`找不到源文件：${SOURCE}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(SOURCE);
  const original = workbook.worksheets[0];
  original.name = '原始台账';

  const rows = [];
  for (let rowNumber = 3; rowNumber <= original.rowCount; rowNumber += 1) {
    const cells = original.getRow(rowNumber).values.slice(1);
    const row = {
      sourceRow: rowNumber,
      sequence: text(cells[0]),
      name: String(text(cells[1]) || ''),
      legacyCode: String(text(cells[2]) || ''),
      purchasedAt: text(cells[3]),
      maker: String(text(cells[4]) || ''),
      area: String(text(cells[5]) || ''),
      line: String(text(cells[6]) || ''),
    };
    if ([row.name, row.legacyCode, row.maker, row.area, row.line].some(Boolean)) rows.push(row);
  }

  const legacyCounts = new Map();
  for (const row of rows) {
    if (!row.legacyCode) continue;
    const key = row.legacyCode.toUpperCase();
    legacyCounts.set(key, (legacyCounts.get(key) || 0) + 1);
  }
  const duplicateCodes = new Set([...legacyCounts].filter(([, count]) => count > 1).map(([code]) => code));
  const counters = new Map();
  const results = rows.map((row) => {
    const classification = classify(row.name, row.line);
    const review = baseReview(row, duplicateCodes);
    if (!classification.type) {
      review.reasons.push(classification.standard ? '该记录尚未确认对应的独立设备类型。' : '未能按当前规则识别设备类型。');
      review.blockCode = true;
    }
    let proposedCode = '';
    if (!review.blockCode && classification.type) {
      const key = `${classification.type}|${classification.spec}`;
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      proposedCode = `YSM-${classification.type}-${classification.spec ? `${classification.spec}-` : ''}${String(next).padStart(4, '0')}`;
    }
    return {
      ...row,
      ...classification,
      proposedCode,
      reviewStatus: review.reasons.length ? '待核实' : review.confirmedCorrections.length ? '原表错误已确认' : '规则初审通过',
      reviewNote: [...review.confirmedCorrections, ...review.reasons].join('；'),
    };
  });

  const suggestion = workbook.addWorksheet('设备命名建议', { views: [{ state: 'frozen', ySplit: 2, xSplit: 2 }] });
  suggestion.mergeCells('A1:M1');
  suggestion.getCell('A1').value = '安徽优胜美新材料科技有限公司（2026年设备台账命名建议）';
  suggestion.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  suggestion.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B4D' } };
  suggestion.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };
  suggestion.getRow(1).height = 32;

  const headers = ['序号', '原设备名称', '标准设备名称', '类型代码', '关键规格', '建议永久设备编码', '核查状态', '核查备注', '原设备编号', '购买时间', '设备厂家', '区域', '生产线'];
  suggestion.getRow(2).values = headers;
  suggestion.getRow(2).height = 30;
  suggestion.getRow(2).eachCell((cell, col) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col >= 3 && col <= 8 ? 'FF176B4D' : 'FF52645C' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border();
  });
  suggestion.columns = [
    { width: 8 }, { width: 24 }, { width: 22 }, { width: 12 }, { width: 14 }, { width: 27 },
    { width: 14 }, { width: 60 }, { width: 20 }, { width: 14 }, { width: 30 }, { width: 14 }, { width: 26 },
  ];
  suggestion.autoFilter = { from: 'A2', to: 'M2' };

  results.forEach((item, index) => {
    const row = suggestion.getRow(index + 3);
    row.values = [
      item.sequence, item.name, item.standard, item.type, item.spec, item.proposedCode,
      item.reviewStatus, item.reviewNote, item.legacyCode, item.purchasedAt, item.maker, item.area, item.line,
    ];
    row.height = 27;
    row.eachCell((cell, col) => {
      cell.alignment = { vertical: 'middle', horizontal: [1, 4, 5, 6, 7, 9, 10, 12].includes(col) ? 'center' : 'left', wrapText: true };
      cell.border = border();
      if (col >= 3 && col <= 8) {
        const fill = item.reviewStatus === '待核实' ? 'FFFFF3DB' : item.reviewStatus === '原表错误已确认' ? 'FFFFE8E8' : 'FFF0F8F4';
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      }
      if (col === 7) {
        const color = item.reviewStatus === '待核实' ? 'FFB45F06' : item.reviewStatus === '原表错误已确认' ? 'FFB42318' : 'FF176B4D';
        cell.font = { bold: true, color: { argb: color } };
      }
    });
    if (item.purchasedAt instanceof Date) row.getCell(10).numFmt = 'yyyy-mm-dd';
  });

  const codeSheet = workbook.addWorksheet('类型代码表');
  codeSheet.columns = [{ header: '类型代码', key: 'code', width: 14 }, { header: '设备类型', key: 'name', width: 28 }, { header: '本表使用数量', key: 'count', width: 16 }];
  const typeCounts = results.reduce((map, item) => {
    if (item.type) map.set(item.type, (map.get(item.type) || 0) + 1);
    return map;
  }, new Map());
  [...typeCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([code, count]) => codeSheet.addRow({ code, name: TYPE_NAMES[code], count }));
  codeSheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B4D' } };
  });

  await workbook.xlsx.writeFile(OUTPUT);

  const proposed = results.filter((item) => item.proposedCode);
  const uniqueCodes = new Set(proposed.map((item) => item.proposedCode));
  const unclassified = results.filter((item) => !item.type && !item.standard);
  const summary = {
    sourceRows: rows.length,
    proposedCodes: proposed.length,
    pendingReview: results.filter((item) => item.reviewStatus === '待核实').length,
    confirmedSourceErrors: results.filter((item) => item.reviewStatus === '原表错误已确认').length,
    uniqueCodes: uniqueCodes.size,
    duplicateSuggestedCodes: proposed.length - uniqueCodes.size,
    unclassified: unclassified.map((item) => `${item.sourceRow}:${item.name}`),
    output: OUTPUT,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (rows.length !== 218) throw new Error(`有效记录应为218条，实际${rows.length}条`);
  if (proposed.length !== uniqueCodes.size) throw new Error('建议永久设备编码存在重复');
  if (unclassified.length) throw new Error(`存在未分类设备：${summary.unclassified.join('、')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
