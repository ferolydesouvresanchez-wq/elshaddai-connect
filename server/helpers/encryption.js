const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

// Derive encryption key from environment or generate a stable one
function getEncryptionKey() {
  const secret = process.env.STREAM_ENCRYPTION_KEY || process.env.JWT_SECRET || 'elshaddai-connect-stream-key-default';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plainText) {
  if (!plainText) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  // Format: iv:tag:encrypted
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const key = getEncryptionKey();
    const parts = encryptedText.split(':');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[Encryption] Decrypt failed:', e.message);
    return null;
  }
}

// Mask a stream key for display (show first 4 and last 4 chars)
function maskKey(key) {
  if (!key || key.length < 10) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

module.exports = { encrypt, decrypt, maskKey };
