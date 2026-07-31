// ============================================================
// Vault — Group Routes
// ============================================================

import { UUID_PATTERN } from '../utils/constants.js';

// Tells a user's other active connections that group membership changed,
// so their client can refresh its cached member list (used for E2EE
// group fan-out) instead of only finding out on the next message.
function notifyGroupMembersChanged(fastify, memberIds, groupId, group) {
  for (const memberId of memberIds) {
    const sockets = fastify.store.getConnections(memberId);
    const payload = JSON.stringify({ type: 'group_updated', groupId, group });
    for (const s of sockets) {
      try { s.send(payload); } catch {}
    }
  }
}

function notifyRemovedFromGroup(fastify, userId, groupId) {
  const sockets = fastify.store.getConnections(userId);
  const payload = JSON.stringify({ type: 'group_removed', groupId });
  for (const s of sockets) {
    try { s.send(payload); } catch {}
  }
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

  // ─── JOIN group using Join Key ───────────────────────────
  fastify.post('/api/groups/join', {
    preValidation: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['joinKey'],
        properties: {
          joinKey: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { joinKey } = request.body;
    
    // Find the group by join key
    const group = await fastify.store.getGroupByJoinKey(joinKey);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found with this join key' });
    }
    
    // Add member to group
    await fastify.store.addGroupMember(group.id, request.user.id);

    // Fetch refreshed group object with new member lists
    const updatedGroup = await fastify.store.getGroup(group.id);

    // Let existing members know someone new joined so their client
    // refreshes its cached member list for E2EE group fan-out.
    notifyGroupMembersChanged(
      fastify,
      updatedGroup.members.map(m => m.id).filter(id => id !== request.user.id),
      group.id,
      updatedGroup
    );

    return reply.code(200).send(updatedGroup);
  });

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

    // Note: this removes the departing member from future server-side
    // fan-out, but does not rotate the group's E2EE sender key — anyone
    // who already derived it (including a removed member) could still
    // decrypt messages encrypted with it going forward until each
    // remaining member's client independently starts a fresh session.
    notifyGroupMembersChanged(fastify, remainingMemberIds, id, { ...group, members: group.members.filter(m => m.id !== request.user.id) });

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
    // Notify remaining members (same forward-secrecy caveat as leaving above).
    notifyGroupMembersChanged(fastify, remainingMemberIds, id, { ...group, members: updatedMembers });
    // Also tell the removed member directly, so their client drops the group.
    notifyRemovedFromGroup(fastify, userId, id);

    return reply.send({ success: true });
  });

}

export default groupRoutes;
