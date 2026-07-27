'use strict';

// 预置故障代码：参考旧系统 YEMS 后台截图里那 21 个扁平故障码
// （电机异响/电机不转/电机发热/轴承异响/轴承不转/链条损坏/链条断裂/管道漏油/
//   管道漏料/开关故障/电源线故障/电器元件/负载/高温/电源/磨损/松动/损坏/短路/
//   无法启动/无法工作），按需求说明书第 11 章要求的「故障类别 → 故障部位 → 故障现象」
// 三级结构重新整理而成。
//
// ⚠️ 这是**待设备科确认的建议值**，不是现场确认过的标准。入库时 is_seeded=1，
// 界面上会标注"系统预置 · 待确认"，管理员可以随意增删改。只在表为空时种入，
// 不会覆盖人工维护过的数据。
//
// requires_photo：拍照真正有用的才置 1（漏液、外观损坏这类看照片就能判断的），
// 「异响」这种拍了也没用的不强制，避免为了拍照而拍照。
//
// is_common：出现在普工报修页"常用故障"快捷按钮上的那几条。只标"整机层面、
// 不用拆开看就能判断"的——普工说得出"机器不转了"，说不出"是轴承还是传动松动"。
// 等真实工单攒起来之后，快捷按钮改按历史频次排，这个标记只在冷启动阶段起作用。

const DEFAULT_FAULT_CODES = Object.freeze([
  // ── 电气故障 ──
  { code: 'EL-MOT-NOSTART', category: '电气故障', part: '主电机', symptom: '无法启动', suggested_action: '先查空开与热继电器是否跳闸，再测三相电压', default_urgency: 'URGENT', requires_downtime: 1 },
  { code: 'EL-MOT-NOISE', category: '电气故障', part: '主电机', symptom: '异响', suggested_action: '听声判断轴承还是缺相，停机盘车检查' },
  { code: 'EL-MOT-HOT', category: '电气故障', part: '主电机', symptom: '发热', suggested_action: '测运行电流并对比铭牌额定值，检查散热风扇' },
  { code: 'EL-MOT-OVERLOAD', category: '电气故障', part: '主电机', symptom: '电流过高（负载异常）', suggested_action: '检查负载是否卡阻、传动是否偏心' },
  { code: 'EL-SW-FAULT', category: '电气故障', part: '开关按钮', symptom: '开关失灵', suggested_action: '断电后用万用表测通断，检查触点氧化' },
  { code: 'EL-PWR-LINE', category: '电气故障', part: '电源线路', symptom: '线路故障', requires_photo: 1, suggested_action: '检查线缆有无破损、端子有无松动发黑' },
  { code: 'EL-PWR-SHORT', category: '电气故障', part: '电源线路', symptom: '短路跳闸', default_urgency: 'CRITICAL', requires_downtime: 1, requires_photo: 1, suggested_action: '立即断电，排查短路点后再送电' },
  { code: 'EL-CMP-BROKEN', category: '电气故障', part: '电器元件', symptom: '元件损坏', requires_photo: 1, suggested_action: '拍下元件型号铭牌，确认备件规格后更换' },

  // ── 机械故障 ──
  { code: 'ME-BRG-NOISE', category: '机械故障', part: '轴承', symptom: '异响', suggested_action: '听诊定位，检查润滑是否到位' },
  { code: 'ME-BRG-STUCK', category: '机械故障', part: '轴承', symptom: '卡死不转', default_urgency: 'URGENT', requires_downtime: 1, suggested_action: '停机手动盘车确认，多为缺油或异物进入' },
  { code: 'ME-BRG-HOT', category: '机械故障', part: '轴承', symptom: '发热', suggested_action: '测温并补充润滑脂，持续升温需停机' },
  { code: 'ME-CHN-LOOSE', category: '机械故障', part: '链条皮带', symptom: '松动打滑', suggested_action: '调整张紧装置，检查张紧轮' },
  { code: 'ME-CHN-WORN', category: '机械故障', part: '链条皮带', symptom: '磨损损坏', requires_photo: 1, suggested_action: '拍下磨损部位，测量伸长量决定是否更换' },
  { code: 'ME-CHN-BROKEN', category: '机械故障', part: '链条皮带', symptom: '断裂', default_urgency: 'CRITICAL', requires_downtime: 1, requires_photo: 1, suggested_action: '立即停机，检查断口判断是否有卡阻原因' },
  { code: 'ME-TRM-WORN', category: '机械故障', part: '传动部件', symptom: '磨损', requires_photo: 1, suggested_action: '检查齿轮、联轴器的配合面' },
  { code: 'ME-TRM-LOOSE', category: '机械故障', part: '传动部件', symptom: '松动', suggested_action: '按力矩要求重新紧固并做防松标记' },
  { code: 'ME-STR-DAMAGE', category: '机械故障', part: '机体结构', symptom: '外观损坏', requires_photo: 1, suggested_action: '拍照记录损坏范围，评估是否影响安全防护' },

  // ── 液压气动 ──
  // 漏油漏料站在机器边上就看得见，普工判断得了，进快捷按钮
  { code: 'HY-PIP-OIL', category: '液压气动', part: '管路', symptom: '漏油', requires_photo: 1, is_common: 1, suggested_action: '拍下渗漏点，检查接头与密封圈' },
  { code: 'HY-PIP-MAT', category: '液压气动', part: '管路', symptom: '漏料', requires_photo: 1, is_common: 1, suggested_action: '拍下渗漏点，检查法兰与密封面' },

  // ── 综合 ──
  { code: 'GEN-ALL-NOSTART', category: '综合', part: '整机', symptom: '整机无法启动', default_urgency: 'URGENT', requires_downtime: 1, is_common: 1, suggested_action: '先确认供电、急停、安全门联锁状态' },
  { code: 'GEN-ALL-ABNORMAL', category: '综合', part: '整机', symptom: '无法正常工作', is_common: 1, suggested_action: '描述具体表现，便于技术员到场前判断' },
  { code: 'GEN-ALL-HOT', category: '综合', part: '整机', symptom: '整机温度过高', is_common: 1, suggested_action: '检查冷却系统与环境通风' },
  // 兜底项：选它时系统会强制要求填写补充说明，避免出现一堆只写着"其他"的工单
  { code: 'GEN-ALL-OTHER', category: '综合', part: '整机', symptom: '其他（请在补充说明里描述）', suggested_action: '请尽量写清现象、发生时机和已经做过的处理' },
]);

// 兜底故障码：选中它时补充说明变必填，并用补充说明回填工单的故障现象
const FALLBACK_FAULT_CODE = 'GEN-ALL-OTHER';

module.exports = { DEFAULT_FAULT_CODES, FALLBACK_FAULT_CODE };
