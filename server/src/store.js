// ============================================================
// Vault — PostgreSQL + Redis Production Data Store
// ============================================================

import pg from 'pg';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// Ensure uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'vault',
  password: process.env.PGPASSWORD || 'vault_dev_pass',
  database: process.env.PGDATABASE || 'vault',
  max: 50,
  idleTimeoutMillis: 30000,
};

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

const initSchemaSQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(32) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    identity_key    TEXT NOT NULL,
    signed_prekey   TEXT NOT NULL,
    prekey_sig      TEXT NOT NULL,
    salt            TEXT NOT NULL,
    encrypted_vault TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key      TEXT NOT NULL,
    used            BOOLEAN DEFAULT FALSE,
    uploaded_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_user_unused ON one_time_prekeys (user_id, used)
    WHERE used = FALSE;

CREATE TABLE IF NOT EXISTS encrypted_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext      TEXT NOT NULL,
    ephemeral_key   TEXT,
    message_number  INTEGER NOT NULL,
    previous_chain  INTEGER DEFAULT 0,
    sent_at         TIMESTAMPTZ DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    delivered       BOOLEAN DEFAULT FALSE,
    read            BOOLEAN DEFAULT FALSE,
    iv              TEXT,
    group_id        TEXT,
    attachment_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_recipient_undelivered
    ON encrypted_messages (recipient_id, delivered, sent_at)
    WHERE delivered = FALSE;

CREATE INDEX IF NOT EXISTS idx_msg_expires ON encrypted_messages (expires_at);

CREATE TABLE IF NOT EXISTS groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    join_key        TEXT UNIQUE,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename        TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    total_chunks    INTEGER NOT NULL DEFAULT 1,
    uploaded_chunks INTEGER NOT NULL DEFAULT 0,
    burn_on_read    BOOLEAN DEFAULT FALSE,
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachment_allowed_users (
    attachment_id   UUID NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (attachment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_expires ON attachments (expires_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription    TEXT NOT NULL,
    PRIMARY KEY (user_id, subscription)
);
`;

class DataStore {
  constructor() {
    this.pool = new Pool(pgConfig);
    this.redis = new Redis(redisConfig);
    this.wsConnections = new Map(); // userId -> Set of socket objects
    this.activeCalls = new Map();   // userId -> peerId

    // Initialize Schema
    this.pool.query(initSchemaSQL)
      .then(() => console.log('[DB] Schema initialized successfully'))
      .catch((err) => console.error('[DB] Schema initialization failed:', err));
  }

  // ─── Users ────────────────────────────────────────────────

  async createUser({ username, passwordHash, identityKey, signedPrekey, prekeySig, salt, encryptedVault = null }) {
    const res = await this.pool.query(
      `INSERT INTO users (username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault, created_at`,
      [username, passwordHash, identityKey, signedPrekey, prekeySig, salt, encryptedVault]
    );
    return res.rows[0];
  }

  async updateUserKeys(id, { identityKey, signedPrekey, prekeySig }) {
    const res = await this.pool.query(
      `UPDATE users SET identity_key = $1, signed_prekey = $2, prekey_sig = $3
       WHERE id = $4
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt`,
      [identityKey, signedPrekey, prekeySig, id]
    );
    return res.rows[0] || null;
  }

  async updateSignedPrekey(id, signedPrekey, prekeySig) {
    const res = await this.pool.query(
      `UPDATE users SET signed_prekey = $1, prekey_sig = $2
       WHERE id = $3
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt`,
      [signedPrekey, prekeySig, id]
    );
    return res.rows[0] || null;
  }

  async setEncryptedVault(id, encryptedVault) {
    const res = await this.pool.query(
      `UPDATE users SET encrypted_vault = $1
       WHERE id = $2
       RETURNING id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault`,
      [encryptedVault, id]
    );
    return res.rows[0] || null;
  }

  async resetPrekeys(userId, publicKeys) {
    await this.pool.query(`DELETE FROM one_time_prekeys WHERE user_id = $1`, [userId]);
    if (publicKeys.length > 0) {
      await this.uploadPrekeys(userId, publicKeys);
    }
  }

  getDummySalt(username) {
    return crypto.createHmac('sha256', 'dummy_salt_key')
      .update(username)
      .digest('base64')
      .substring(0, 24);
  }

  async getUserByUsername(username) {
    const res = await this.pool.query(
      `SELECT id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault FROM users
       WHERE LOWER(username) = LOWER($1)`,
      [username]
    );
    return res.rows[0] || null;
  }

  async getUserById(id) {
    const res = await this.pool.query(
      `SELECT id, username, password_hash, identity_key, signed_prekey, prekey_sig, salt, encrypted_vault FROM users
       WHERE id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  // ─── Prekeys ──────────────────────────────────────────────

  async uploadPrekeys(userId, publicKeys) {
    if (publicKeys.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const pk of publicKeys) {
        await client.query(
          `INSERT INTO one_time_prekeys (user_id, public_key) VALUES ($1, $2)`,
          [userId, pk]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async consumePrekey(userId) {
    const res = await this.pool.query(
      `UPDATE one_time_prekeys SET used = TRUE
       WHERE id = (
         SELECT id FROM one_time_prekeys
         WHERE user_id = $1 AND used = FALSE
         ORDER BY uploaded_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING public_key`,
      [userId]
    );
    return res.rows[0] ? res.rows[0].public_key : null;
  }

  async countUnusedPrekeys(userId) {
    const res = await this.pool.query(
      `SELECT COUNT(*) as count FROM one_time_prekeys
       WHERE user_id = $1 AND used = FALSE`,
      [userId]
    );
    return parseInt(res.rows[0].count, 10);
  }

  async getKeyBundle(username) {
    const user = await this.getUserByUsername(username);
    if (!user) return null;
    const opk = await this.consumePrekey(user.id);
    return {
      identityKey: user.identity_key,
      signedPrekey: user.signed_prekey,
      prekeySig: user.prekey_sig,
      oneTimePrekey: opk
    };
  }

  // ─── Messages ─────────────────────────────────────────────

  async createMessage({ senderId, recipientId, ciphertext, ephemeralKey, messageNumber, previousChain, expiresAt, iv, groupId = null, attachmentId = null }) {
    const res = await this.pool.query(
      `INSERT INTO encrypted_messages (sender_id, recipient_id, ciphertext, ephemeral_key, message_number, previous_chain, expires_at, iv, group_id, attachment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, sender_id, recipient_id, ciphertext, ephemeral_key, message_number, previous_chain, expires_at, sent_at, iv, group_id, attachment_id`,
      [senderId, recipientId, ciphertext, ephemeralKey, messageNumber, previousChain, expiresAt, iv, groupId, attachmentId]
    );

    const msg = res.rows[0];

    // Auto authorize recipient on attachment if any
    if (attachmentId) {
      await this.authorizeAttachmentUser(attachmentId, recipientId);
    }

    return msg;
  }

  async markDelivered(messageId) {
    await this.pool.query(
      `UPDATE encrypted_messages SET delivered = TRUE WHERE id = $1`,
      [messageId]
    );
  }

  async markRead(messageId) {
    await this.pool.query(
      `UPDATE encrypted_messages SET read = TRUE WHERE id = $1`,
      [messageId]
    );
  }

  async getMessage(id) {
    const res = await this.pool.query(
      `SELECT * FROM encrypted_messages WHERE id = $1`,
      [id]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  async getUndeliveredMessages(recipientId) {
    const res = await this.pool.query(
      `SELECT m.*, u.username as sender_username FROM encrypted_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.recipient_id = $1 AND m.delivered = FALSE
       ORDER BY m.sent_at ASC`,
      [recipientId]
    );
    return res.rows.map(row => ({
      id: row.id,
      sender_id: row.sender_id,
      sender_username: row.sender_username,
      recipient_id: row.recipient_id,
      ciphertext: row.ciphertext,
      ephemeral_key: row.ephemeral_key,
      message_number: row.message_number,
      previous_chain: row.previous_chain,
      sent_at: row.sent_at,
      expires_at: row.expires_at,
      iv: row.iv,
      group_id: row.group_id,
      attachment_id: row.attachment_id,
      read: row.read
    }));
  }

  async getConversationMessages(userId1, userId2, limit = 50, before = null) {
    let query = `
      SELECT m.*, u.username as sender_username FROM encrypted_messages m
      JOIN users u ON m.sender_id = u.id
      WHERE (
        (m.sender_id = $1 AND m.recipient_id = $2) OR
        (m.sender_id = $2 AND m.recipient_id = $1)
      )
    `;
    const params = [userId1, userId2, limit];
    if (before) {
      query += ` AND m.sent_at < $4`;
      params.push(before);
    }
    query += ` ORDER BY m.sent_at DESC LIMIT $3`;
    const res = await this.pool.query(query, params);
    return res.rows.map(row => ({
      id: row.id,
      sender_id: row.sender_id,
      sender_username: row.sender_username,
      recipient_id: row.recipient_id,
      ciphertext: row.ciphertext,
      ephemeral_key: row.ephemeral_key,
      message_number: row.message_number,
      previous_chain: row.previous_chain,
      sent_at: row.sent_at,
      expires_at: row.expires_at,
      iv: row.iv,
      group_id: row.group_id,
      attachment_id: row.attachment_id,
      read: row.read
    }));
  }

  async getConversationsForUser(userId) {
    const res = await this.pool.query(
      `SELECT DISTINCT ON (peer_id)
         peer_id,
         username as peer_username,
         last_message_at
       FROM (
         SELECT recipient_id as peer_id, sent_at as last_message_at FROM encrypted_messages WHERE sender_id = $1
         UNION ALL
         SELECT sender_id as peer_id, sent_at as last_message_at FROM encrypted_messages WHERE recipient_id = $1
       ) t
       JOIN users u ON t.peer_id = u.id
       ORDER BY peer_id, last_message_at DESC`,
      [userId]
    );
    return res.rows.map(row => ({
      peerId: row.peer_id,
      peerUsername: row.peer_username,
      lastMessageAt: row.last_message_at,
      hasUndelivered: false
    }));
  }

  // ─── Pending Queue (Redis) ───────────────────────────────

  async enqueuePending(recipientId, messageId) {
    await this.redis.sadd(`pending:${recipientId}`, messageId);
  }

  async dequeuePending(recipientId) {
    const messages = await this.redis.smembers(`pending:${recipientId}`);
    await this.redis.del(`pending:${recipientId}`);
    return messages;
  }

  async removePending(recipientId, messageId) {
    await this.redis.srem(`pending:${recipientId}`, messageId);
  }

  // ─── WebSockets Connections (Volatile RAM) ────────────────

  registerConnection(userId, socket) {
    if (!this.wsConnections.has(userId)) {
      this.wsConnections.set(userId, new Set());
    }
    this.wsConnections.get(userId).add(socket);
  }

  unregisterConnection(userId, socket) {
    if (this.wsConnections.has(userId)) {
      this.wsConnections.get(userId).delete(socket);
      if (this.wsConnections.get(userId).size === 0) {
        this.wsConnections.delete(userId);
      }
    }
  }

  getConnections(userId) {
    return this.wsConnections.get(userId) || new Set();
  }

  isOnline(userId) {
    return this.wsConnections.has(userId);
  }

  // ─── Sessions (Redis) ─────────────────────────────────────

  async createSession(jwtId, userId) {
    await this.redis.set(`session:${jwtId}`, userId, 'EX', 24 * 60 * 60);
  }

  async getSession(jwtId) {
    const userId = await this.redis.get(`session:${jwtId}`);
    return userId ? { userId } : null;
  }

  async deleteSession(jwtId) {
    await this.redis.del(`session:${jwtId}`);
  }

  async touchSession(jwtId) {
    await this.redis.expire(`session:${jwtId}`, 24 * 60 * 60);
  }

  // ─── User Search ──────────────────────────────────────────

  async searchUsers(query, excludeUserId) {
    const res = await this.pool.query(
      `SELECT id, username FROM users
       WHERE username ILIKE $1 AND id <> $2
       LIMIT 20`,
      [`%${query}%`, excludeUserId]
    );
    return res.rows;
  }

  // ─── Attachments (Disk + SQL Metadata) ────────────────────

  async saveAttachment(filename, mimeType, totalChunksOrCiphertext = '', burnOnRead = false, ownerId = null) {
    const id = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    
    let totalChunks = 1;
    let ciphertext = '';
    
    if (typeof totalChunksOrCiphertext === 'number') {
      totalChunks = totalChunksOrCiphertext;
    } else {
      ciphertext = totalChunksOrCiphertext;
    }
    
    // Save metadata
    await this.pool.query(
      `INSERT INTO attachments (id, filename, mime_type, total_chunks, uploaded_chunks, burn_on_read, owner_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, filename, mimeType, totalChunks, 0, burnOnRead, ownerId, expiresAt]
    );

    // Save owner as allowed user
    if (ownerId) {
      await this.authorizeAttachmentUser(id, ownerId);
    }

    // Write chunk 0 if ciphertext is provided immediately
    if (ciphertext) {
      await this.saveChunk(id, 0, ciphertext);
    }

    return id;
  }

  async getAttachment(id) {
    const res = await this.pool.query(
      `SELECT * FROM attachments WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    const allowed = await this.pool.query(
      `SELECT user_id FROM attachment_allowed_users WHERE attachment_id = $1`,
      [id]
    );
    const allowedUsers = new Set(allowed.rows.map(r => r.user_id));

    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      totalChunks: row.total_chunks,
      uploadedChunks: row.uploaded_chunks,
      burn_on_read: row.burn_on_read,
      owner_id: row.owner_id,
      expires_at: row.expires_at,
      allowed_users: allowedUsers
    };
  }

  async authorizeAttachmentUser(attachmentId, userId) {
    await this.pool.query(
      `INSERT INTO attachment_allowed_users (attachment_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [attachmentId, userId]
    );
  }

  async saveChunk(id, index, ciphertext) {
    const filePath = path.join(UPLOADS_DIR, `${id}_${index}.txt`);
    await fs.promises.writeFile(filePath, ciphertext, 'utf8');

    // Update chunk metadata
    await this.pool.query(
      `UPDATE attachments
       SET uploaded_chunks = uploaded_chunks + 1,
           total_chunks = GREATEST(total_chunks, $2 + 1)
       WHERE id = $1`,
      [id, index]
    );
  }

  async getChunk(id, index) {
    const filePath = path.join(UPLOADS_DIR, `${id}_${index}.txt`);
    try {
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (e) {
      return null;
    }
  }

  async deleteAttachment(id) {
    const attachment = await this.getAttachment(id);
    if (!attachment) return;

    // Delete chunks from disk
    for (let i = 0; i < attachment.totalChunks; i++) {
      const filePath = path.join(UPLOADS_DIR, `${id}_${i}.txt`);
      await fs.promises.unlink(filePath).catch(() => {});
    }

    // Delete database records
    await this.pool.query(`DELETE FROM attachments WHERE id = $1`, [id]);
  }

  // ─── Groups (PostgreSQL) ──────────────────────────────────

  async createGroup(name, memberIds) {
    const id = uuidv4();
    const joinKey = uuidv4();
    await this.pool.query(
      `INSERT INTO groups (id, name, join_key) VALUES ($1, $2, $3)`,
      [id, name, joinKey]
    );

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const mId of memberIds) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
          [id, mId]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return await this.getGroup(id);
  }

  async getGroup(id) {
    const res = await this.pool.query(
      `SELECT * FROM groups WHERE id = $1`,
      [id]
    );
    if (res.rows.length === 0) return null;

    const group = res.rows[0];
    const membersRes = await this.pool.query(
      `SELECT u.id, u.username FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = $1`,
      [id]
    );

    return {
      id: group.id,
      name: group.name,
      joinKey: group.join_key,
      members: membersRes.rows
    };
  }

  async getGroupByJoinKey(joinKey) {
    const res = await this.pool.query(
      `SELECT id FROM groups WHERE join_key = $1`,
      [joinKey]
    );
    if (res.rows.length === 0) return null;
    return await this.getGroup(res.rows[0].id);
  }

  async addGroupMember(groupId, userId) {
    await this.pool.query(
      `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, userId]
    );
  }

  async getGroupsForUser(userId) {
    const res = await this.pool.query(
      `SELECT group_id FROM group_members WHERE user_id = $1`,
      [userId]
    );
    
    const list = [];
    for (const row of res.rows) {
      const group = await this.getGroup(row.group_id);
      if (group) list.push(group);
    }
    return list;
  }

  // ─── Push Subscriptions (PostgreSQL) ──────────────────────

  async addPushSubscription(userId, subscription) {
    await this.pool.query(
      `INSERT INTO push_subscriptions (user_id, subscription)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, subscription]
    );
  }

  async getPushSubscriptions(userId) {
    const res = await this.pool.query(
      `SELECT subscription FROM push_subscriptions WHERE user_id = $1`,
      [userId]
    );
    return new Set(res.rows.map(r => r.subscription));
  }

  // ─── Calls (Volatile RAM) ─────────────────────────────────

  registerCall(userId, peerId) {
    this.activeCalls.set(userId, peerId);
    this.activeCalls.set(peerId, userId);
  }

  unregisterCall(userId) {
    const peerId = this.activeCalls.get(userId);
    this.activeCalls.delete(userId);
    if (peerId) {
      this.activeCalls.delete(peerId);
    }
  }

  getActiveCall(userId) {
    return this.activeCalls.get(userId);
  }

  // ─── Reaper (Cleanup Job) ─────────────────────────────────

  async reap() {
    const now = new Date().toISOString();
    
    // Delete expired attachments from disk
    const expiredAttachments = await this.pool.query(
      `SELECT id, total_chunks FROM attachments WHERE expires_at < $1`,
      [now]
    );

    for (const row of expiredAttachments.rows) {
      for (let i = 0; i < row.total_chunks; i++) {
        const filePath = path.join(UPLOADS_DIR, `${row.id}_${i}.txt`);
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }

    // Delete records from DB
    await this.pool.query(`DELETE FROM attachments WHERE expires_at < $1`, [now]);

    // Delete expired messages
    const expiredMsgs = await this.pool.query(
      `DELETE FROM encrypted_messages WHERE expires_at < $1 RETURNING id`,
      [now]
    );
    
    return expiredMsgs.rowCount;
  }

  async checkAndIncrementUploadUsage(userId, size) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
    const redisKey = `user:upload_limit:${userId}:${yearMonth}`;

    const usageStr = await this.redis.get(redisKey);
    const currentUsage = usageStr ? parseInt(usageStr, 10) : 0;
    const LIMIT = 50 * 1024 * 1024; // 50MB

    if (currentUsage + size > LIMIT) {
      throw new Error('Monthly upload limit of 50MB exceeded');
    }

    await this.redis.incrby(redisKey, size);
    await this.redis.expire(redisKey, 35 * 24 * 60 * 60); // 35 days
  }
}

// Singleton instance
const store = new DataStore();
export default store;
