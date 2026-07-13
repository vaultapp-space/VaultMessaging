// ============================================================
// Vault — Group Routes
// ============================================================

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
    
    const group = await fastify.store.createGroup(name, allMembers);
    
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
    return reply.code(200).send(updatedGroup);
  });

}

export default groupRoutes;
