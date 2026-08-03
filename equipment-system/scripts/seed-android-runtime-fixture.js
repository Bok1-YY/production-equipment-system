'use strict'; // Isolated Android emulator fixture; not part of the Node test discovery set.

const os = require('node:os');
const path = require('node:path');
const { openDatabase, DEFAULT_ADMIN_USERNAME } = require('../src/db');
const { EquipmentService } = require('../src/service');
const { levelToRole } = require('../src/auth');

const allowedRoot = path.resolve(os.tmpdir(), 'ysm-android-runtime-test');
const databasePath = path.resolve(
  process.argv[2] || path.join(allowedRoot, 'equipment.db'),
);
if (!databasePath.startsWith(`${allowedRoot}${path.sep}`)) {
  throw new Error(`Android runtime test database must stay under ${allowedRoot}`);
}

const db = openDatabase(databasePath);
try {
  const service = new EquipmentService(db, {
    attachmentRoot: path.join(allowedRoot, 'attachments'),
  });
  const admin = service.listUsers().find(
    (item) => item.username === DEFAULT_ADMIN_USERNAME,
  );
  const user = service.publicUser(admin.id);
  const manager = {
    actor: user.display_name,
    user_id: user.id,
    username: user.username,
    level: user.level,
    role: levelToRole(user.level),
  };

  let reviewerUser = service.listUsers().find(
    (item) => item.username === 'android-reviewer',
  );
  if (!reviewerUser) {
    reviewerUser = service.createUser({
      username: 'android-reviewer',
      display_name: 'Android 测试审核员',
      level: 3,
    }, manager);
  }
  const reviewer = {
    actor: reviewerUser.display_name,
    user_id: reviewerUser.id,
    username: reviewerUser.username,
    level: reviewerUser.level,
    role: levelToRole(reviewerUser.level),
  };

  const existing = service.listEquipment().find(
    (item) => item.standard_name === 'Android 模拟器巡检设备',
  );
  if (existing) {
    const pending = service.listCompositionChanges().find(
      (item) => item.equipment_id === existing.id && item.status === 'PENDING',
    );
    if (pending) {
      service.reviewCompositionChange(pending.id, { decision: 'APPROVED' }, reviewer);
    }
    const current = service.listEquipment().find((item) => item.id === existing.id);
    process.stdout.write(`${JSON.stringify(current)}\n`);
    process.exitCode = 0;
  } else {
    let organization = service.organization();
    const workshop = organization.workshops[0];
    const line = organization.lines.find((item) => item.code === 'ANDROID-L01')
      || service.createLine({
        workshop_id: workshop.id,
        code: 'ANDROID-L01',
        name: 'Android 测试产线',
      }, manager);
    organization = service.organization();
    const processItem = organization.processes.find(
      (item) => item.code === 'ANDROID-L01-P01',
    ) || service.createProcess({
      line_id: line.id,
      code: 'ANDROID-L01-P01',
      name: '模拟巡检工序',
    }, manager);
    organization = service.organization();
    const position = organization.positions.find(
      (item) => item.code === 'ANDROID-L01-P01-S01',
    ) || service.createPosition({
      process_id: processItem.id,
      code: 'ANDROID-L01-P01-S01',
      name: '模拟巡检机位',
    }, manager);
    if (!service.listEquipmentTypes().some((item) => item.code === 'ANDR')) {
      service.createEquipmentType({
        code: 'ANDR',
        name: 'Android 测试设备',
      }, manager);
    }
    const equipment = service.createEquipment({
      standard_name: 'Android 模拟器巡检设备',
      category: '测试设备',
      type_code: 'ANDR',
      key_spec: 'API35',
    }, manager);
    service.createCompositionChange({
      action: 'INSTALL',
      equipment_id: equipment.id,
      to_position_id: position.id,
      reason: 'Android APK 运行验证',
    }, manager);
    const change = service.listCompositionChanges()[0];
    service.reviewCompositionChange(change.id, { decision: 'APPROVED' }, reviewer);
    process.stdout.write(`${JSON.stringify(equipment)}\n`);
  }
} finally {
  db.close();
}
