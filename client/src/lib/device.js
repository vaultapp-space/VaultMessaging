// ============================================================
// Vault — device identity
// ============================================================
// A label for this browser, sent at sign-in so the account owner can tell
// their sessions apart in Active Sessions.
//
// Deliberately coarse. A precise fingerprint would identify the browser
// across accounts, which is exactly the tracking surface this product exists
// to avoid — and it would buy nothing, because nothing is authorised by this
// value. The server treats it as a label and no more.

function browserName(ua) {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

function platformName(ua) {
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Web';
}

/** The fields register and login send to identify this session. */
export function describeThisDevice() {
  const ua = navigator.userAgent || '';
  const platform = platformName(ua);
  return {
    deviceName: `${browserName(ua)} on ${platform}`,
    platform,
    appVersion: 'web',
  };
}
