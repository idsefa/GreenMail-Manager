const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmail-sms-test-'));
const db = require('../server/db');
const { storeMessage } = require('../server/message-store');

function sms(content, msgTs = 1791000000) {
  return {
    devId: 'sms-test', type: 501, slot: 1, phone: '10010', content,
    msgTs, receivedAt: msgTs, rawJson: JSON.stringify({ smsBd: content }),
    message: { devId: 'sms-test', type: 501, slot: 1, phNum: '10010', smsBd: content, smsTs: msgTs }
  };
}

test('distinct SMS in the same second are preserved while copies are reconciled', () => {
  const first = storeMessage(sms('第一条短信，内容不同'));
  const second = storeMessage(sms('第二条短信，内容不同'));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.notEqual(first.id, second.id);
  assert.equal(storeMessage(sms('第一条短信，内容不同')).duplicate, true);

  const damaged = storeMessage(sms('您的余�已不足，请及时充值', 1791000001));
  const repaired = storeMessage(sms('您的余额已不足，请及时充值', 1791000001));
  assert.equal(repaired.duplicate, true);
  assert.equal(repaired.improved, true);
  assert.equal(db.prepare('SELECT content FROM messages WHERE id = ?').get(damaged.id).content, '您的余额已不足，请及时充值');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 3);
});
