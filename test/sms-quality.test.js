const test = require('node:test');
const assert = require('node:assert/strict');
const { isBetterSmsContent, areLikelySameSms } = require('../server/sms-quality');

test('prefers a clean SMS copy without replacing it with a fragment', () => {
  const clean = '温馨提示：您的套餐本月还有很多流量，点击 https://example.com/query 查询详情。';
  const duplicated = clean.slice(0, 45) + clean;
  const corrupted = clean.replace('很多', '很�');
  assert.equal(isBetterSmsContent(duplicated, clean), true);
  assert.equal(isBetterSmsContent(corrupted, clean), true);
  assert.equal(isBetterSmsContent(clean, clean.slice(0, 20)), false);
  assert.equal(isBetterSmsContent(clean, corrupted), false);
  assert.equal(areLikelySameSms('第一条短信', '第二条短信'), false);
  assert.equal(areLikelySameSms(corrupted, clean), true);
});
