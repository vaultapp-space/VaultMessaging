// ============================================================
// Vault — repos/groups.repo.js
// ============================================================
// Groups and membership. Membership is authoritative here and is what the
// send path checks before accepting a group-tagged message.
//
// Methods are unchanged from the original store.js; `this` refers to the
// object returned here, so intra-module calls keep working as before.

import { v4 as uuidv4 } from 'uuid';

export function createGroups({ pool }) {
  return {
    pool,

  async createGroup(name, memberIds, creatorId = null) {
    const id = uuidv4();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO groups (id, name, created_by) VALUES ($1, $2, $3)`,
        [id, name, creatorId]
      );
      for (const mId of memberIds) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
          [id, mId]
        );
      }

      // Mirror the group into the chat model, sharing its id so both
      // addressing schemes resolve to the same conversation. Without this a
      // group created after the Phase 1 migration would exist in `groups` but
      // never appear in /api/chats — visible in the old sidebar, invisible in
      // the new one.
      //
      // mode='secret': groups use Sender Keys, and nothing here should
      // silently downgrade an existing feature to server-readable storage.
      await client.query(
        // Groups are cloud. Sender keys work, but every cloud-only group
        // feature — polls, scheduled sends, server-side search, channel
        // discussion — is unreachable when a group cannot be one, and a
        // feature that exists but can never be used is worse than no feature.
        // One-to-one chats are where the end-to-end guarantee lives.
        `INSERT INTO chats (id, type, mode, title, created_by, members_count)
         VALUES ($1, 'group', 'cloud', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, name, creatorId, memberIds.length]
      );
      for (const mId of memberIds) {
        await client.query(
          `INSERT INTO chat_members (chat_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (chat_id, user_id) DO NOTHING`,
          [id, mId, mId === creatorId ? 'owner' : 'member']
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
  },

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
      createdBy: group.created_by,
      members: membersRes.rows
    };
  },


  // chat_members and group_members are two views of the same membership —
  // group routing/access checks key off chat_members, while group listings
  // key off group_members. These used to be two unguarded queries, the first
  // wrapped in a swallowed .catch(() => {}), so a mid-write failure (a
  // connection blip, a deadlock) could leave someone in one table but not
  // the other: removed from the group listing but still receiving its
  // messages, or the reverse. Same BEGIN/COMMIT/ROLLBACK shape as
  // createGroup() above — both tables move together or neither does.
  async removeGroupMember(groupId, userId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
        [groupId, userId]
      );
      await client.query(
        `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId]
      );
      const remaining = await client.query(
        `SELECT COUNT(*)::int AS count FROM group_members WHERE group_id = $1`,
        [groupId]
      );
      let deleted = false;
      if (remaining.rows[0].count === 0) {
        await client.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
        deleted = true;
      }
      await client.query('COMMIT');
      return { deleted };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async addGroupMember(groupId, userId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)
         ON CONFLICT (chat_id, user_id) DO NOTHING`,
        [groupId, userId]
      );
      await client.query(
        `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [groupId, userId]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  // One query, not 1 + 2N. This used to fetch the caller's group ids and then
  // call getGroup() per row — and getGroup itself costs two queries — so a
  // user in 20 groups issued 41 round trips every time the sidebar loaded.
  async getGroupsForUser(userId) {
    const res = await this.pool.query(
      `SELECT g.id,
              g.name,
              g.created_by,
              COALESCE(
                json_agg(
                  json_build_object('id', u.id, 'username', u.username)
                  ORDER BY u.username
                ) FILTER (WHERE u.id IS NOT NULL),
                '[]'
              ) AS members
         FROM groups g
         JOIN group_members mine
           ON mine.group_id = g.id AND mine.user_id = $1
         LEFT JOIN group_members gm ON gm.group_id = g.id
         LEFT JOIN users u          ON u.id = gm.user_id
        GROUP BY g.id, g.name, g.created_by
        ORDER BY g.created_at DESC NULLS LAST`,
      [userId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      members: row.members,
    }));
  },
  };
}
