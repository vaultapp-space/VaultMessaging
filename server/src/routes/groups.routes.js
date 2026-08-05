// ============================================================
// Vault — Group Routes
// ============================================================

import { UUID_PATTERN } from '../utils/constants.js';

// Tells a user's other active connections that group membership changed,
// so their client can refresh its cached member list (used for E2EE
// group fan-out) instead of only finding out on the next message.
function notifyGroupMembersChanged(fastify, memberIds, groupId, group, membershipChange = null) {
  return fastify.fanout.deliverToUsers(memberIds, {
    type: 'group_updated', groupId, group, membershipChange,
  });
}

function notifyRemovedFromGroup(fastify, userId, groupId) {
  return fastify.fanout.deliverToUser(userId, { type: 'group_removed', groupId });
}

async function groupRoutes(fastify) {

  // ─── CREATE group ─────────────────────────────────────────
  fastify.post('/api/groups', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'members'],
        properties: {
          name:    { type: 'string', maxLength: 100 },
          members: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1
          }
        }
      }
    }
  }, async (request, reply) => {
    const { name, members } = request.body;

    // Ensure requesting user is always in the group members
    const allMembers = Array.from(new Set([request.user.id, ...members]));

    const group = await fastify.store.createGroup(name, allMembers, request.user.id);

    return reply.code(201).send(group);
  });

  // ─── GET groups ───────────────────────────────────────────
  fastify.get('/api/groups', {
    preValidation: [fastify.authenticate]
  }, async (request, reply) => {
    const list = await fastify.store.getGroupsForUser(request.user.id);
    return reply.send(list);
  });

  // The old `POST /api/groups/join` lived here. It took a permanent,
  // unrevocable bearer secret: anyone who had ever seen a group's join key
  // could rejoin forever, including members who had been removed or banned.
  // `chat_invites` (0008) replaced it with revocable, expiring, attributable
  // links, and 0016 dropped the column. Do not reintroduce a bearer-secret
  // join path.

  // ─── LEAVE group (self) ───────────────────────────────────
  fastify.post('/api/groups/:id/leave', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', pattern: UUID_PATTERN } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;

    const group = await fastify.store.getGroup(id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    if (!group.members.some(m => m.id === request.user.id)) {
      return reply.code(403).send({ error: 'Not a member of this group' });
    }

    const remainingMemberIds = group.members.map(m => m.id).filter(id => id !== request.user.id);
    await fastify.store.removeGroupMember(id, request.user.id);

    // membershipChange: 'departed' tells remaining members' clients to
    // rotate their E2EE Sender Key and redistribute it to the reduced
    // member set, so the departing member's copy of the old key stops
    // being useful for anything encrypted after this point.
    await notifyGroupMembersChanged(fastify, remainingMemberIds, id, { ...group, members: group.members.filter(m => m.id !== request.user.id) }, 'departed');

    return reply.send({ success: true });
  });

  // ─── REMOVE a member (group creator only) ─────────────────
  fastify.delete('/api/groups/:id/members/:userId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'userId'],
        properties: {
          id:     { type: 'string', pattern: UUID_PATTERN },
          userId: { type: 'string', pattern: UUID_PATTERN }
        }
      }
    }
  }, async (request, reply) => {
    const { id, userId } = request.params;

    const group = await fastify.store.getGroup(id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    if (group.createdBy !== request.user.id) {
      return reply.code(403).send({ error: 'Only the group creator can remove members' });
    }
    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'Use the leave endpoint to remove yourself' });
    }
    if (!group.members.some(m => m.id === userId)) {
      return reply.code(404).send({ error: 'User is not a member of this group' });
    }

    await fastify.store.removeGroupMember(id, userId);

    const updatedMembers = group.members.filter(m => m.id !== userId);
    const remainingMemberIds = updatedMembers.map(m => m.id);
    // Same key-rotation signal as leaving above.
    await notifyGroupMembersChanged(fastify, remainingMemberIds, id, { ...group, members: updatedMembers }, 'departed');
    // Also tell the removed member directly, so their client drops the group.
    await notifyRemovedFromGroup(fastify, userId, id);

    return reply.send({ success: true });
  });

}

export default groupRoutes;
