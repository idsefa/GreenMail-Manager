export function getDeviceName(device) {
  return String(device?.device_name || device?.name || '').trim();
}

export function getDeviceSn(device) {
  return String(device?.dev_id || '').trim();
}

export function getDeviceDisplayParts(device, { preferName = true } = {}) {
  const name = getDeviceName(device);
  const sn = getDeviceSn(device);
  const hasCustomName = name && name !== sn;

  if (preferName && hasCustomName) {
    return { primary: name, secondary: sn };
  }

  if (!preferName && sn) {
    return { primary: sn, secondary: hasCustomName ? name : '' };
  }

  return {
    primary: name || sn || '-',
    secondary: '',
  };
}

export function formatDeviceInline(device, { preferName = true, empty = '-' } = {}) {
  const { primary, secondary } = getDeviceDisplayParts(device, { preferName });
  if (!primary || primary === '-') return empty;
  return secondary ? `${primary} (${secondary})` : primary;
}

export function formatDeviceIdList(rawValue, devicesById = {}) {
  const ids = String(rawValue || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return ids
    .map(devId => formatDeviceInline({ dev_id: devId, name: devicesById[devId] || '' }))
    .join(', ');
}
