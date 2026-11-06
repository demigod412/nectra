/* ==========================================================================
   Compliance — terms acceptance + KYC (identity verification for lending)
   PII is minimized: we keep name, country, DOB, document type and the last 4
   of the ID only. Full document numbers/images are never stored here.
   ========================================================================== */
'use strict';
const { q, now, getSettings } = require('./db');
const { notify, notifyAdmins } = require('./events');

/* Is identity verification enabled platform-wide? */
const kycEnabled = () => getSettings().kyc_enabled !== false;

/* Accept a small government-ID image as a data URL; validate type + size. */
const DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_DOC_BYTES = 4 * 1024 * 1024;
function validateDoc(dataUrl, label) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || !DOC_TYPES.includes(m[1])) { const e = new Error(`${label} must be a JPEG, PNG or WebP image`); e.status = 400; throw e; }
  const bytes = Math.floor(m[2].length * 0.75);
  if (bytes > MAX_DOC_BYTES) { const e = new Error(`${label} is too large (max 4 MB). Try a smaller photo.`); e.status = 400; throw e; }
  return `data:${m[1]};base64,${m[2]}`;
}

/* ---------- terms ---------- */
function termsStatus(user) {
  const s = getSettings();
  return { version: s.current_terms_version, accepted: user.terms_version === s.current_terms_version, acceptedVersion: user.terms_version || null, acceptedAt: user.terms_accepted_at || null };
}
function acceptTerms(userId) {
  const s = getSettings();
  q.run('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?', s.current_terms_version, now(), userId);
  return termsStatus(q.get('SELECT * FROM users WHERE id = ?', userId));
}

/* ---------- KYC ---------- */
function kycRow(userId) { return q.get('SELECT * FROM kyc WHERE user_id = ?', userId) || { user_id: userId, status: 'none', level: 'basic' }; }
function kycStatus(userId) {
  const k = kycRow(userId); const s = getSettings();
  return { enabled: kycEnabled(), status: k.status, level: k.level, note: k.note || null, submittedAt: k.submitted_at || null, reviewedAt: k.reviewed_at || null,
    fields: k.status === 'none' ? null : { fullName: k.full_name, country: k.country, dob: k.dob, idType: k.id_type, idLast4: k.id_last4, address: k.address },
    docs: { front: !!k.doc_front, back: !!k.doc_back },
    requiredForLoans: !!s.kyc_required_for_loans, requiredForLive: !!s.kyc_required_for_live };
}
/** The stored ID image (data URL) for admin review, or null. */
function kycDoc(userId, side) { const k = kycRow(userId); return (side === 'back' ? k.doc_back : k.doc_front) || null; }
function submitKyc(userId, d) {
  if (!kycEnabled()) { const e = new Error('Identity verification is not required right now'); e.status = 403; throw e; }
  const clean = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);
  const fullName = clean(d.fullName, 120), country = clean(d.country, 56), dob = clean(d.dob, 20), idType = clean(d.idType, 24), address = clean(d.address, 200);
  const idNum = clean(d.idNumber, 40).replace(/\s/g, '');
  if (!fullName || !country || !dob || !idType || !idNum) { const e = new Error('Please fill in your name, country, date of birth, ID type and ID number'); e.status = 400; throw e; }
  if (!d.idFront) { const e = new Error('Please upload a photo of your government ID (front)'); e.status = 400; throw e; }
  const front = validateDoc(d.idFront, 'The ID front image');
  const back = d.idBack ? validateDoc(d.idBack, 'The ID back image') : null;
  const last4 = idNum.slice(-4);
  const at = now();
  q.run(`INSERT INTO kyc(user_id, status, level, full_name, country, dob, id_type, id_last4, address, doc_front, doc_back, submitted_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET status='submitted', full_name=excluded.full_name, country=excluded.country, dob=excluded.dob,
      id_type=excluded.id_type, id_last4=excluded.id_last4, address=excluded.address, doc_front=excluded.doc_front, doc_back=excluded.doc_back,
      submitted_at=excluded.submitted_at, updated_at=excluded.updated_at, note=NULL, reviewed_by=NULL, reviewed_at=NULL`,
    userId, 'submitted', 'basic', fullName, country, dob, idType, last4, address, front, back, at, at);
  notifyAdmins('security', 'New KYC submission', `${fullName} (${country}) submitted a government ID for review.`, '/admin/#kyc');
  return kycStatus(userId);
}
function decideKyc(userId, decision, note, byId) {
  const status = decision === 'verified' ? 'verified' : 'rejected';
  q.run('UPDATE kyc SET status = ?, note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE user_id = ?', status, note || null, byId, now(), now(), userId);
  notify(userId, 'security', status === 'verified' ? 'Identity verified ✓' : 'Identity check needs attention',
    status === 'verified' ? 'Your KYC is approved — you can now apply for loans.' : `Your KYC was not approved${note ? ': ' + note : ''}. You can resubmit.`, 'settings.html#kyc');
  return kycStatus(userId);
}
const kycVerified = (userId) => kycRow(userId).status === 'verified';

/* ---------- gates (throw HttpError-like {status,message}) ---------- */
function requireTerms(user) { if (!termsStatus(user).accepted) { const e = new Error('Please review and accept the current Terms & Risk Disclosure first.'); e.status = 451; throw e; } }
function requireKycForLoan(user) { if (kycEnabled() && getSettings().kyc_required_for_loans && !kycVerified(user.id)) { const e = new Error('Identity verification (KYC) is required before applying for a loan. Complete it in Settings → Identity.'); e.status = 451; throw e; } }
function requireKycForLive(user) { if (kycEnabled() && getSettings().kyc_required_for_live && !kycVerified(user.id)) { const e = new Error('Identity verification (KYC) is required for live trading. Complete it in Settings → Identity.'); e.status = 451; throw e; } }

module.exports = { kycEnabled, termsStatus, acceptTerms, kycRow, kycStatus, kycDoc, submitKyc, decideKyc, kycVerified, requireTerms, requireKycForLoan, requireKycForLive };
