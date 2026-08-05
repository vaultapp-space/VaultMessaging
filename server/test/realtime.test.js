import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';

import { createRegistry } from '../src/realtime/registry.js';
import { createFanout } from '../src/realtime/fanout.js';
import { createCallState } from '../src/realtime/calls.js';
import { createBus } from '../src/realtime/bus.js';
import { redisConfig } from '../src/db/config.js';
import { TEST_REDIS_DB } from './helpers/harness.js';

// A stand-in for a WebSocket that records what was written to it.
function fakeSocket({ failing = false } = {}) {
  return {
    sent: [],
    readyState: 1,
    send(payload) {
      if (failing) throw new Error('socket is gone');
      this.sent.push(typeof payload === 'string' ? JSON.parse(payload) : payload);
    },
  };
}

let redis;

before(() => {
  redis = new Redis({ ...redisConfig, db: TEST_REDIS_DB });
});

after(() => {
  redis.disconnect();
});

beforeEach(async () => {
  await redis.flushdb();
});

describe('connection registry', () => {
  test('tracks and releases a socket for a user', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const userId = randomUUID();
    const socket = fakeSocket();

    assert.equal(registry.isLocallyConnected(userId), false);

    await registry.register(userId, socket);
    assert.equal(registry.isLocallyConnected(userId), true);
    assert.equal(registry.getLocal(userId).size, 1);

    await registry.unregister(userId, socket);
    assert.equal(registry.isLocallyConnected(userId), false);
    assert.equal(registry.getLocal(userId).size, 0);
  });

  test('supports several sockets for one user', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const userId = randomUUID();
    const a = fakeSocket();
    const b = fakeSocket();

    await registry.register(userId, a);
    await registry.register(userId, b);
    assert.equal(registry.getLocal(userId).size, 2);
    assert.equal(await registry.connectionCount(userId), 2);

    // Closing one tab must not mark the user offline.
    await registry.unregister(userId, a);
    assert.equal(registry.isLocallyConnected(userId), true);
    assert.equal(registry.getLocal(userId).size, 1);
  });

  test('reports a user connected on another process as online', async () => {
    // This is the property that makes multi-process delivery possible: a
    // process with no local socket still knows the user is reachable.
    const one = createRegistry({ redis, processId: 'p1' });
    const two = createRegistry({ redis, processId: 'p2' });
    const userId = randomUUID();

    await one.register(userId, fakeSocket());

    assert.equal(two.isLocallyConnected(userId), false);
    assert.equal(await two.isOnline(userId), true);
    assert.deepEqual(await two.routesFor(userId), ['p1']);
  });

  test('a user with no connections is offline everywhere', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    assert.equal(await registry.isOnline(randomUUID()), false);
  });

  test('unregistering clears the cross-process route', async () => {
    const one = createRegistry({ redis, processId: 'p1' });
    const two = createRegistry({ redis, processId: 'p2' });
    const userId = randomUUID();
    const socket = fakeSocket();

    await one.register(userId, socket);
    assert.equal(await two.isOnline(userId), true);

    await one.unregister(userId, socket);
    assert.equal(await two.isOnline(userId), false);
    assert.deepEqual(await two.routesFor(userId), []);
  });

  test('presence keys carry a TTL so a crashed process expires', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const userId = randomUUID();
    await registry.register(userId, fakeSocket());

    const ttl = await redis.ttl(`presence:${userId}`);
    assert.ok(ttl > 0, `expected a positive TTL, got ${ttl}`);
  });

  test('survives Redis being unavailable', async () => {
    // Presence is best-effort; a Redis outage must not drop sockets.
    const broken = {
      multi() { return { sadd: () => this, expire: () => this, exec: () => { throw new Error('down'); } }; },
      srem() { throw new Error('down'); },
      scard() { throw new Error('down'); },
      smembers() { throw new Error('down'); },
    };
    const registry = createRegistry({ redis: broken, processId: 'p1' });
    const userId = randomUUID();
    const socket = fakeSocket();

    await registry.register(userId, socket);
    assert.equal(registry.isLocallyConnected(userId), true, 'local delivery still works');
    assert.equal(await registry.isOnline(userId), true, 'falls back to local knowledge');
  });
});

describe('fanout', () => {
  test('delivers to every socket a user has', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const fanout = createFanout({ registry, bus: null });
    const userId = randomUUID();
    const a = fakeSocket();
    const b = fakeSocket();

    await registry.register(userId, a);
    await registry.register(userId, b);

    const count = await fanout.deliverToUser(userId, { type: 'ping' });

    assert.equal(count, 2);
    assert.deepEqual(a.sent, [{ type: 'ping' }]);
    assert.deepEqual(b.sent, [{ type: 'ping' }]);
  });

  test('delivering to an offline user is a no-op, not an error', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const fanout = createFanout({ registry, bus: null });

    assert.equal(await fanout.deliverToUser(randomUUID(), { type: 'ping' }), 0);
  });

  test('one broken socket does not stop the others', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const fanout = createFanout({ registry, bus: null, logger: { warn() {} } });
    const userId = randomUUID();
    const broken = fakeSocket({ failing: true });
    const healthy = fakeSocket();

    await registry.register(userId, broken);
    await registry.register(userId, healthy);

    const count = await fanout.deliverToUser(userId, { type: 'ping' });

    assert.equal(count, 1);
    assert.deepEqual(healthy.sent, [{ type: 'ping' }]);
  });

  test('excludes a nominated socket', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const fanout = createFanout({ registry, bus: null });
    const userId = randomUUID();
    const origin = fakeSocket();
    const other = fakeSocket();

    await registry.register(userId, origin);
    await registry.register(userId, other);

    await fanout.deliverToUser(userId, { type: 'echo' }, { excludeSocket: origin });

    assert.deepEqual(origin.sent, []);
    assert.deepEqual(other.sent, [{ type: 'echo' }]);
  });

  test('deliverToUsers reaches a group and honours exclusions', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const fanout = createFanout({ registry, bus: null });

    const members = [randomUUID(), randomUUID(), randomUUID()];
    const sockets = members.map(() => fakeSocket());
    for (let i = 0; i < members.length; i += 1) {
      await registry.register(members[i], sockets[i]);
    }

    await fanout.deliverToUsers(members, { type: 'group_updated' }, { exclude: [members[0]] });

    assert.deepEqual(sockets[0].sent, [], 'the excluded member is skipped');
    assert.deepEqual(sockets[1].sent, [{ type: 'group_updated' }]);
    assert.deepEqual(sockets[2].sent, [{ type: 'group_updated' }]);
  });

  test('accepts a pre-serialised payload', async () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const fanout = createFanout({ registry, bus: null });
    const userId = randomUUID();
    const socket = fakeSocket();
    await registry.register(userId, socket);

    await fanout.deliverToUser(userId, JSON.stringify({ type: 'preformatted' }));

    assert.deepEqual(socket.sent, [{ type: 'preformatted' }]);
  });

  test('applies a message arriving from another process', async () => {
    const registry = createRegistry({ redis, processId: 'p2' });
    const fanout = createFanout({ registry, bus: null });
    const userId = randomUUID();
    const socket = fakeSocket();
    await registry.register(userId, socket);

    fanout.handleBusMessage({
      kind: 'deliver',
      userId,
      payload: JSON.stringify({ type: 'from-elsewhere' }),
    });

    assert.deepEqual(socket.sent, [{ type: 'from-elsewhere' }]);
  });

  test('ignores an unrecognised bus envelope', () => {
    const registry = createRegistry({ redis, processId: 'p1' });
    const fanout = createFanout({ registry, bus: null });
    assert.doesNotThrow(() => fanout.handleBusMessage({ kind: 'nonsense' }));
    assert.doesNotThrow(() => fanout.handleBusMessage(null));
  });
});

describe('cross-process bus', () => {
  test('carries a delivery from one process to the socket on another', async () => {
    // The end-to-end property that lets this run in cluster mode: a message
    // published on the process that handled the request reaches the process
    // that actually holds the recipient's socket.
    const publisherRedis = new Redis({ ...redisConfig, db: TEST_REDIS_DB });
    const subscriberRedis = new Redis({ ...redisConfig, db: TEST_REDIS_DB });

    try {
      const registryTwo = createRegistry({ redis, processId: 'p2' });
      const fanoutTwo = createFanout({ registry: registryTwo, bus: null });

      const busTwo = createBus({
        redis: publisherRedis,
        subscriber: subscriberRedis,
        processId: 'p2',
        onMessage: (envelope) => fanoutTwo.handleBusMessage(envelope),
      });
      await busTwo.start();

      const userId = randomUUID();
      const socket = fakeSocket();
      await registryTwo.register(userId, socket);

      // Process 1 has no local socket for this user, but knows p2 does.
      const registryOne = createRegistry({ redis, processId: 'p1' });
      const busOne = createBus({
        redis: publisherRedis, subscriber: null, processId: 'p1', onMessage: () => {},
      });
      const fanoutOne = createFanout({ registry: registryOne, bus: busOne });

      assert.deepEqual(await registryOne.routesFor(userId), ['p2']);
      await fanoutOne.deliverToUser(userId, { type: 'crossed-processes' });

      // Allow the pub/sub round trip to land.
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.deepEqual(socket.sent, [{ type: 'crossed-processes' }]);
      await busTwo.stop();
    } finally {
      publisherRedis.disconnect();
      subscriberRedis.disconnect();
    }
  });
});

describe('call state', () => {
  test('registers a call for both parties and clears both on hangup', async () => {
    const calls = createCallState();
    calls.registerCall('a', 'b');

    assert.equal(calls.getActiveCall('a'), 'b');
    assert.equal(calls.getActiveCall('b'), 'a');

    calls.unregisterCall('a');
    assert.equal(calls.getActiveCall('a'), undefined);
    assert.equal(calls.getActiveCall('b'), undefined, 'the peer is released too');
  });

  test('a pending invite round-trips and clears', () => {
    const calls = createCallState();
    calls.setPendingInvite('invitee', 'caller');

    assert.equal(calls.getPendingInvite('invitee'), 'caller');

    calls.clearPendingInvite('invitee');
    assert.equal(calls.getPendingInvite('invitee'), undefined);
  });

  test('clears an invite from either side', () => {
    // The caller may cancel before the invitee ever answers.
    const calls = createCallState();
    calls.setPendingInvite('invitee', 'caller');

    calls.clearPendingInvitesInvolving('caller');
    assert.equal(calls.getPendingInvite('invitee'), undefined);
  });

  test('an unrelated invite survives a clear', () => {
    const calls = createCallState();
    calls.setPendingInvite('inviteeA', 'callerA');
    calls.setPendingInvite('inviteeB', 'callerB');

    calls.clearPendingInvitesInvolving('callerA');

    assert.equal(calls.getPendingInvite('inviteeA'), undefined);
    assert.equal(calls.getPendingInvite('inviteeB'), 'callerB');
  });
});
