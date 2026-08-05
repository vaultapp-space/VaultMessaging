// ============================================================
// Vault — Devices and sync
// ============================================================
// Two things a multi-device account cannot do without.
//
// **Active Sessions.** Until now a session was an opaque Redis key, so there
// was no way to answer "what is signed in to my account?" and no way to sign
// out a phone you no longer have. Both are ordinary expectations of a
// messenger, and the second is a security control, not a convenience: a lost
// device otherwise keeps working until its token expires.
//
// **Catch-up.** A device that was offline asks what it missed since the last
// `pts` it saw. Cloud chats replay in full; secret chats deliberately do not,
// and the reason is worth stating — the server holds only ciphertext for
// them, and the keys live on one device. That is Telegram's behaviour too,
// and pretending otherwise would mean either weakening the encryption or
// showing a second device an empty conversation with no explanation.

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function deviceRoutes(fastify) {

  // ─── LIST my devices ──────────────────────────────────────
  fastify.get('/api/devices', {
    preValidation: [fastify.authenticate],
  }, async (request) => {
    const devices = await fastify.repos.devices.listForUser(request.user.id);
    return {
      devices: devices.map((d) => ({
        ...d,
        // So the UI can label one row "this device" and refuse to make
        // signing yourself out look like signing someone else out.
        current: d.id === request.deviceId,
      })),
    };
  });

  // ─── REVOKE a device ──────────────────────────────────────
  fastify.delete('/api/devices/:deviceId', {
    preValidation: [fastify.authenticate],
    schema: {
      params: {
        type: 'object', required: ['deviceId'],
        properties: { deviceId: { type: 'string', pattern: UUID_PATTERN } },
      },
    },
  }, async (request, reply) => {
    const { deviceId } = request.params;

    // Ownership is enforced inside the UPDATE rather than by a check first:
    // a separate read-then-write is a race, and this is the one operation
    // where losing it means one account signing out another's device.
    const revoked = await fastify.repos.devices.revoke(request.user.id, deviceId);
    if (!revoked) return reply.code(404).send({ error: 'Device not found' });

    // Tearing down the sessions is what makes revocation take effect now
    // rather than whenever the token expires — up to a day later.
    await fastify.store.deleteSessionsForDevice(deviceId);

    // And close its sockets, or a connected client keeps receiving messages
    // on a connection that was authenticated before the revocation.
    await fastify.fanout.deliverToUser(request.user.id, {
      type: 'device_revoked', deviceId,
    });

    return reply.send({ revoked: deviceId });
  });

  // ─── CATCH UP ─────────────────────────────────────────────
  //
  // `tooLong` is not an error. It means the gap is bigger than the log can
  // serve — which, with a 24h retention, mostly means the device was offline
  // for more than a day. The client throws away local state and refetches,
  // and that is cheap precisely because there is only ever a day of it.
  fastify.get('/api/updates', {
    preValidation: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: { pts: { type: 'integer', minimum: 0, default: 0 } },
      },
    },
  }, async (request) => {
    const result = await fastify.repos.devices.since(request.user.id, request.query.pts);

    // Record how far this device has caught up, so a later reconnect from
    // the same device does not replay what it has already applied.
    if (request.deviceId && !result.tooLong) {
      await fastify.repos.devices.setPts(request.deviceId, result.pts);
    }

    return result;
  });
}

export default deviceRoutes;
