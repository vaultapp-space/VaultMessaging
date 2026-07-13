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

}

export default groupRoutes;
