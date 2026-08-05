// ============================================================
// Vault — realtime/calls.js
// ============================================================
// WebRTC call state: who is in a call with whom, and which invites are
// outstanding.
//
// The pending-invite map is security-relevant, not bookkeeping. `call_accept`
// is only honoured when it matches an invite actually sent to that user —
// without it, any authenticated client could accept a call "from" an
// arbitrary user and overwrite that person's active-call mapping, which then
// lets SDP/ICE be relayed to the wrong peer. ws.routes.js enforces this and
// test/ws.routes.test.js covers it.

export function createCallState() {
  const activeCalls = new Map();   // userId -> peerId (recorded both ways)
  const pendingInvites = new Map(); // inviteeId -> callerId

  return {
    activeCalls,
    pendingInvites,

    setPendingInvite(inviteeId, callerId) {
      pendingInvites.set(inviteeId, callerId);
    },

    getPendingInvite(inviteeId) {
      return pendingInvites.get(inviteeId);
    },

    clearPendingInvite(inviteeId) {
      pendingInvites.delete(inviteeId);
    },

    // Clears a pending invite regardless of whether `id` is the invitee (the
    // usual key) or the caller cancelling before the invitee ever accepted.
    clearPendingInvitesInvolving(id) {
      pendingInvites.delete(id);
      for (const [inviteeId, callerId] of pendingInvites.entries()) {
        if (callerId === id) pendingInvites.delete(inviteeId);
      }
    },

    registerCall(userId, peerId) {
      activeCalls.set(userId, peerId);
      activeCalls.set(peerId, userId);
    },

    unregisterCall(userId) {
      const peerId = activeCalls.get(userId);
      activeCalls.delete(userId);
      if (peerId) activeCalls.delete(peerId);
    },

    getActiveCall(userId) {
      return activeCalls.get(userId);
    },
  };
}
