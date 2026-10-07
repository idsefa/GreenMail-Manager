function hasRepeatedPrefix(content) {
  const text = String(content || '');
  for (let length = 40; length <= Math.min(200, Math.floor(text.length / 2)); length++) {
    if (text.slice(0, length) === text.slice(length, length * 2)) return true;
  }
  return false;
}

function isBetterSmsContent(current, candidate) {
  const oldText = String(current || '');
  const newText = String(candidate || '');
  if (!newText || newText === oldText) return false;
  if (!oldText) return true;

  const oldReplacementCount = (oldText.match(/\uFFFD/g) || []).length;
  const newReplacementCount = (newText.match(/\uFFFD/g) || []).length;
  if (newReplacementCount < oldReplacementCount && newText.length >= oldText.length * 0.8) return true;

  return hasRepeatedPrefix(oldText) && !hasRepeatedPrefix(newText) && oldText.endsWith(newText);
}

function areLikelySameSms(first, second) {
  const a = String(first || '');
  const b = String(second || '');
  if (a === b) return true;
  if (!a || !b) return false;

  if ((hasRepeatedPrefix(a) && a.endsWith(b)) || (hasRepeatedPrefix(b) && b.endsWith(a))) {
    return true;
  }

  const replacementCount = (a.match(/\uFFFD/g) || []).length + (b.match(/\uFFFD/g) || []).length;
  if (!replacementCount || a.length !== b.length) return false;
  let mismatches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) mismatches++;
    if (mismatches > replacementCount + 1) return false;
  }
  return true;
}

module.exports = { isBetterSmsContent, areLikelySameSms };
