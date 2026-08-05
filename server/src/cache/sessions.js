// ============================================================
// Vault — cache/sessions.js
// ============================================================
// Server-side session records keyed by JWT jti. A valid, unexpired token
// whose session record is gone must not authenticate — that is what makes
// logout and remote revocation actually work.
//
// A session now also records which device it belongs to, and every jti for a
// device is tracked in a set alongside it. Without that set, "sign this phone
// out" would have no way to find the tokens to invalidate: a jti is opaque,
// and scanning Redis for one that happens to match is not an option.



export function createSessions({ redis }) {
  return {
    redis,

  async createSession(jwtId, userId, deviceId = null) {
    await this.redis.set(`session:${jwtId}`, userId, 'EX', 24 * 60 * 60);
    if (deviceId) {
      await this.redis.set(`session:${jwtId}:device`, deviceId, 'EX', 24 * 60 * 60);
      // Given a TTL of its own so a device that stops being used does not
      // leave a set of dead jtis behind forever.
      await this.redis.sadd(`device:${deviceId}:sessions`, jwtId);
      await this.redis.expire(`device:${deviceId}:sessions`, 24 * 60 * 60);
    }
  },

  async getSession(jwtId) {
    const userId = await this.redis.get(`session:${jwtId}`);
    if (!userId) return null;
    const deviceId = await this.redis.get(`session:${jwtId}:device`);
    return { userId, deviceId: deviceId || null };
  },

  async deleteSession(jwtId) {
    const deviceId = await this.redis.get(`session:${jwtId}:device`);
    if (deviceId) {
      await this.redis.srem(`device:${deviceId}:sessions`, jwtId);
      await this.redis.del(`session:${jwtId}:device`);
    }
    await this.redis.del(`session:${jwtId}`);
  },

  /**
   * Invalidates every session a device holds.
   *
   * This is what makes "sign out that phone" take effect immediately rather
   * than whenever its token happens to expire — which, with a 24h JWT, would
   * mean up to a day of continued access to an account the owner believes
   * they have already secured.
   */
  async deleteSessionsForDevice(deviceId) {
    const jtis = await this.redis.smembers(`device:${deviceId}:sessions`);
    for (const jti of jtis) {
      await this.redis.del(`session:${jti}`);
      await this.redis.del(`session:${jti}:device`);
    }
    await this.redis.del(`device:${deviceId}:sessions`);
    return jtis.length;
  },

  async touchSession(jwtId) {
    await this.redis.expire(`session:${jwtId}`, 24 * 60 * 60);
    await this.redis.expire(`session:${jwtId}:device`, 24 * 60 * 60);
  },
  };
}
