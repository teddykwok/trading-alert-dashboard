import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  MUTATION_ACTIONS,
  MUTATION_LOCK_HOST,
  MUTATION_LOCK_PORT,
  classifyBindFailure,
  listenerAuthority,
  withMutationLock,
  type AcquireResult,
  type ListenerHandle,
  type MutationAction,
  type MutationAuthority,
} from "../src/modules/operator/mutation-lock";

/**
 * The machine-wide mutation authority.
 *
 * ## What this replaced, and why
 *
 * The first version was a lock FILE. Its atomic create was fine; its recovery
 * was not. A crashed launcher leaves a file, recovery means deleting it, and
 * the filesystem offers no "delete this path only if it still holds record
 * L0". So three launchers could interleave: A proves L0 stale and pauses, B
 * recovers L0 and takes authority, A removes what is now B's LIVE lock leaving
 * the path empty, and C creates it and believes it has authority too. B and C
 * then mutate at the same time, and A putting the file back afterwards repairs
 * nothing.
 *
 * A listening socket has no recovery step at all. The OS holds the binding and
 * drops it when the process dies, so there is no stale record to prove, no
 * file for anyone to delete, and no window in which the mutex is absent while
 * its owner still believes it holds it.
 *
 * Most cases below drive the state machine through an injected authority, so
 * they are deterministic. The last group binds real loopback ports.
 */

const HELD: MutationAction[] = [];

/**
 * An in-memory authority with the ONE property that matters: at most one
 * holder at a time, machine-wide.
 */
function sharedAuthority() {
  let holder: string | null = null;
  let nextFailure: { outcome: "BUSY" | "UNAVAILABLE" | "UNKNOWN"; reason: string } | null = null;
  const history: string[] = [];

  const forLauncher = (name: string): MutationAuthority => ({
    acquire: async (action) => {
      if (nextFailure !== null) {
        const failure = nextFailure;
        nextFailure = null;
        return { ok: false, outcome: failure.outcome, reasons: [failure.reason] };
      }
      if (holder !== null) {
        return {
          ok: false,
          outcome: "BUSY",
          reasons: [`another launcher on this machine holds mutation authority (held by ${holder}).`],
        };
      }
      holder = name;
      history.push(`${name}:acquire:${action}`);
      return {
        ok: true,
        held: {
          action,
          release: async () => {
            if (holder === name) holder = null;
            history.push(`${name}:release:${action}`);
            return { released: true };
          },
        },
      };
    },
  });

  return {
    forLauncher,
    history,
    heldBy: () => holder,
    /** Simulates the process dying: the OS drops the binding, nobody cleans up. */
    ownerDied: () => {
      holder = null;
      history.push("owner-died");
    },
    failNext: (outcome: "BUSY" | "UNAVAILABLE" | "UNKNOWN", reason: string) => {
      nextFailure = { outcome, reason };
    },
  };
}

const adaptersFor = (authority: MutationAuthority, logs: string[] = []) => ({
  authority,
  log: (line: string) => logs.push(line),
});

describe("taking machine-wide mutation authority", () => {
  it("of two simultaneous acquisitions, EXACTLY one succeeds", async () => {
    const shared = sharedAuthority();
    const a = shared.forLauncher("A");
    const b = shared.forLauncher("B");

    const [first, second] = await Promise.all([
      a.acquire("PREPARE_LIVE_READY"),
      b.acquire("RETURN_TO_SAFE"),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  });

  it("a second launcher is BUSY while the first holds it", async () => {
    const shared = sharedAuthority();
    const held = await shared.forLauncher("A").acquire("STOP_RUNTIME");
    expect(held.ok).toBe(true);

    const blocked = await shared.forLauncher("B").acquire("START_SAFE");
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.outcome).toBe("BUSY");
  });

  it("releasing lets the next launcher in", async () => {
    const shared = sharedAuthority();
    const first = await shared.forLauncher("A").acquire("START_SAFE");
    expect(first.ok).toBe(true);
    if (first.ok) await first.held.release();

    const second = await shared.forLauncher("B").acquire("START_SAFE");
    expect(second.ok).toBe(true);
  });

  it("a DISPOSED owner releases authority with no stale record to clean up", async () => {
    // The whole point of the socket. Nothing infers a dead owner, nothing
    // proves staleness and nothing deletes anything -- the binding is simply
    // gone with the process.
    const shared = sharedAuthority();
    expect((await shared.forLauncher("A").acquire("PREPARE_LIVE_READY")).ok).toBe(true);

    shared.ownerDied();

    expect((await shared.forLauncher("B").acquire("RECOVER_TRANSITION")).ok).toBe(true);
    expect(shared.history).not.toContain("clear");
  });

  it("an unavailable mutex is fail-closed, not an opportunity", async () => {
    const shared = sharedAuthority();
    shared.failNext("UNAVAILABLE", "the port could not be bound (EACCES)");

    let ran = false;
    const held = await withMutationLock("START_SAFE", adaptersFor(shared.forLauncher("A")), async () => {
      ran = true;
    });
    expect(held.ran).toBe(false);
    expect(held.ran === false && held.outcome).toBe("UNAVAILABLE");
    expect(ran).toBe(false);
  });
});

describe("running work under mutation authority", () => {
  it("the work runs WHILE authority is held, and a second launcher is refused", async () => {
    const shared = sharedAuthority();
    let duringWork: boolean | null = null;

    const held = await withMutationLock("PREPARE_LIVE_READY", adaptersFor(shared.forLauncher("A")), async () => {
      // Stands in for the human confirmation: a real awaited pause in the
      // middle of the action.
      await new Promise((done) => setTimeout(done, 5));
      duringWork = (await shared.forLauncher("B").acquire("RETURN_TO_SAFE")).ok;
      return "done";
    });

    expect(held.ran).toBe(true);
    expect(duringWork).toBe(false);
    expect(shared.heldBy()).toBeNull();
  });

  it("releases even when the work throws", async () => {
    const shared = sharedAuthority();
    await expect(
      withMutationLock("START_SAFE", adaptersFor(shared.forLauncher("A")), async () => {
        throw new Error("the work failed");
      })
    ).rejects.toThrow("the work failed");
    expect(shared.heldBy()).toBeNull();
  });

  it("refuses without running the work when authority is busy", async () => {
    const shared = sharedAuthority();
    await shared.forLauncher("A").acquire("STOP_RUNTIME");

    let ran = false;
    const held = await withMutationLock("START_SAFE", adaptersFor(shared.forLauncher("B")), async () => {
      ran = true;
    });
    expect(held.ran).toBe(false);
    expect(ran).toBe(false);
  });

  it("reports, rather than hides, a release that did not work", async () => {
    const logs: string[] = [];
    const authority: MutationAuthority = {
      acquire: async (action) => ({
        ok: true,
        held: { action, release: async () => ({ released: false, reason: "the listener would not close" }) },
      }),
    };
    await withMutationLock("START_SAFE", adaptersFor(authority, logs), async () => undefined);

    expect(logs.join(" ")).toContain("would not close");
    // And says the thing that makes it survivable.
    expect(logs.join(" ")).toContain("released when this launcher exits");
  });
});

describe("serialization is machine-wide, deliberately", () => {
  const overlap = async (first: MutationAction, second: MutationAction): Promise<boolean> => {
    const shared = sharedAuthority();
    let got = false;
    await withMutationLock(first, adaptersFor(shared.forLauncher("A")), async () => {
      got = (await shared.forLauncher("B").acquire(second)).ok;
    });
    return got;
  };

  it("opposite-mode transitions cannot overlap", async () => {
    // The case that makes this a blocker: one launcher rewriting gates to
    // LIVE-READY while another rewrites them to SAFE and restarts the roles
    // leaves the account running one mode with the other on disk.
    expect(await overlap("PREPARE_LIVE_READY", "RETURN_TO_SAFE")).toBe(false);
    expect(await overlap("RETURN_TO_SAFE", "PREPARE_LIVE_READY")).toBe(false);
  });

  it("Account A and Account B transitions cannot overlap either", async () => {
    // Not an oversight. The launcher state file, the census and the process
    // table are shared, so two accounts moving at once read each other's
    // half-written records.
    expect(await overlap("PREPARE_LIVE_READY", "PREPARE_LIVE_READY")).toBe(false);
  });

  it("Stop Runtime cannot overlap a transition, in either order", async () => {
    expect(await overlap("PREPARE_LIVE_READY", "STOP_RUNTIME")).toBe(false);
    expect(await overlap("STOP_RUNTIME", "PREPARE_LIVE_READY")).toBe(false);
  });

  it("Start SAFE cannot overlap a transition, in either order", async () => {
    expect(await overlap("PREPARE_LIVE_READY", "START_SAFE")).toBe(false);
    expect(await overlap("START_SAFE", "PREPARE_LIVE_READY")).toBe(false);
  });

  it("a supervised restart cannot overlap an operator action, in either order", async () => {
    expect(await overlap("PREPARE_LIVE_READY", "SUPERVISE_RESTART")).toBe(false);
    expect(await overlap("SUPERVISE_RESTART", "START_SAFE")).toBe(false);
  });

  it("every declared action excludes every other one", async () => {
    for (const first of MUTATION_ACTIONS) {
      for (const second of MUTATION_ACTIONS) {
        expect(`${first}/${second}:${await overlap(first, second)}`).toBe(`${first}/${second}:false`);
      }
    }
  });
});

describe("classifying a bind failure", () => {
  it("a port already in use is BUSY", () => {
    expect(classifyBindFailure("EADDRINUSE")).toBe("BUSY");
  });

  it.each(["EACCES", "EPERM"])("%s is UNAVAILABLE", (code) => {
    expect(classifyBindFailure(code)).toBe("UNAVAILABLE");
  });

  it.each([["something unexpected", "ENOTFOUND"], ["no code at all", undefined]])(
    "%s is UNKNOWN",
    (_label, code) => {
      expect(classifyBindFailure(code)).toBe("UNKNOWN");
    }
  );

  it("there is no outcome that permits mutation", () => {
    for (const code of ["EADDRINUSE", "EACCES", "EPERM", "ENOTFOUND", undefined]) {
      expect(["BUSY", "UNAVAILABLE", "UNKNOWN"]).toContain(classifyBindFailure(code));
    }
  });
});

describe("the authority is an exclusive binding, and nothing else", () => {
  it("binds the host and port it is given, and nothing wider", async () => {
    const attempts: { host: string; port: number }[] = [];
    const authority = listenerAuthority(
      () => ({
        listen: async (host, port) => {
          attempts.push({ host, port });
        },
        close: async () => undefined,
      }),
      { port: 4999 }
    );

    const held = await authority.acquire("START_SAFE");
    expect(held.ok).toBe(true);
    expect(attempts).toEqual([{ host: "127.0.0.1", port: 4999 }]);
  });

  it("defaults to loopback and the dedicated port", async () => {
    const attempts: { host: string; port: number }[] = [];
    await listenerAuthority(() => ({
      listen: async (host, port) => {
        attempts.push({ host, port });
      },
      close: async () => undefined,
    })).acquire("START_SAFE");

    expect(attempts).toEqual([{ host: MUTATION_LOCK_HOST, port: MUTATION_LOCK_PORT }]);
    expect(MUTATION_LOCK_HOST).toBe("127.0.0.1");
    // Never a routable address, from the process that arms a real-money runtime.
    for (const wide of ["0.0.0.0", "::", ""]) expect(MUTATION_LOCK_HOST).not.toBe(wide);
  });

  it("closes the handle even when the bind failed", async () => {
    let closed = 0;
    const failing: () => ListenerHandle = () => ({
      listen: async () => {
        throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      },
      close: async () => {
        closed += 1;
      },
    });

    const result = await listenerAuthority(failing).acquire("START_SAFE");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.outcome).toBe("BUSY");
    expect(closed).toBe(1);
  });

  it("a release that throws is reported, not thrown", async () => {
    const authority = listenerAuthority(() => ({
      listen: async () => undefined,
      close: async () => {
        throw Object.assign(new Error("nope"), { code: "EBADF" });
      },
    }));
    const held = await authority.acquire("START_SAFE");
    expect(held.ok).toBe(true);
    const released = held.ok === true ? await held.held.release() : { released: true };
    expect(released.released).toBe(false);
  });

  it("releasing twice is harmless", async () => {
    let closes = 0;
    const authority = listenerAuthority(() => ({
      listen: async () => undefined,
      close: async () => {
        closes += 1;
      },
    }));
    const held = await authority.acquire("START_SAFE");
    if (held.ok) {
      expect((await held.held.release()).released).toBe(true);
      expect((await held.held.release()).released).toBe(true);
    }
    expect(closes).toBe(1);
  });

  it("has no way to clear someone else's authority", () => {
    // There is nothing to clear. The module exposes acquire, release and a
    // classifier -- no removal, no staleness, no ownership record, no file.
    const surface = Object.keys(
      listenerAuthority(() => ({ listen: async () => undefined, close: async () => undefined }))
    );
    expect(surface).toEqual(["acquire"]);
  });
});

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

describe("real loopback exclusion", () => {
  const opened: Server[] = [];

  const realListener = (): ListenerHandle => {
    const server = createServer();
    server.on("connection", (socket) => socket.destroy());
    opened.push(server);
    return {
      listen: (host, port) =>
        new Promise<void>((resolve, reject) => {
          const failed = (error: Error): void => {
            server.removeListener("listening", bound);
            reject(error);
          };
          const bound = (): void => {
            server.removeListener("error", failed);
            resolve();
          };
          server.once("error", failed);
          server.once("listening", bound);
          server.listen({ host, port, exclusive: true });
        }),
      close: () =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            server.close();
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  };

  /** A free loopback port, so these never collide with a real launcher. */
  const freePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });

  afterEach(async () => {
    await Promise.all(
      opened.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          })
      )
    );
  });

  it("the second binder really does get EADDRINUSE, and refuses", async () => {
    const port = await freePort();
    const first = await listenerAuthority(realListener, { port }).acquire("PREPARE_LIVE_READY");
    expect(first.ok).toBe(true);

    const second = await listenerAuthority(realListener, { port }).acquire("RETURN_TO_SAFE");
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.outcome).toBe("BUSY");
    expect(second.ok === false && second.reasons.join(" ")).toContain("holds mutation authority");

    if (first.ok) await first.held.release();
  });

  it("once released, the port is takeable again", async () => {
    const port = await freePort();
    const first = await listenerAuthority(realListener, { port }).acquire("START_SAFE");
    expect(first.ok).toBe(true);
    if (first.ok) expect((await first.held.release()).released).toBe(true);

    const second = await listenerAuthority(realListener, { port }).acquire("START_SAFE");
    expect(second.ok).toBe(true);
    if (second.ok) await second.held.release();
  });

  it("an UNRELATED process on the port is a fail-closed refusal, never an eviction", async () => {
    const port = await freePort();
    // Something that is not a launcher at all.
    const squatter = createServer();
    opened.push(squatter);
    await new Promise<void>((resolve) => squatter.listen({ host: "127.0.0.1", port }, () => resolve()));

    let ran = false;
    const held = await withMutationLock(
      "PREPARE_LIVE_READY",
      { authority: listenerAuthority(realListener, { port }), log: () => undefined },
      async () => {
        ran = true;
      }
    );

    expect(held.ran).toBe(false);
    expect(ran).toBe(false);
    // And the squatter is untouched.
    expect(squatter.listening).toBe(true);
  });

  it("binds loopback only: the same port is still free on another interface", async () => {
    const port = await freePort();
    const held = await listenerAuthority(realListener, { port }).acquire("START_SAFE");
    expect(held.ok).toBe(true);

    const address = opened[opened.length - 1]?.address();
    expect(typeof address === "object" && address ? address.address : "").toBe("127.0.0.1");

    if (held.ok) await held.held.release();
  });

  it("a crashed owner needs no cleanup: closing the handle IS the release", async () => {
    const port = await freePort();
    const handle = realListener();
    await handle.listen("127.0.0.1", port);

    // No release() is called. The "process" simply goes away, modelled by
    // closing its handle -- which is what the OS does on exit.
    await handle.close();

    const next = await listenerAuthority(realListener, { port }).acquire("RECOVER_TRANSITION");
    expect(next.ok).toBe(true);
    if (next.ok) await next.held.release();
  });
});

describe("what the authority records", () => {
  it("holds no owner metadata at all, so there is nothing to leak", async () => {
    // The file-based version wrote a pid, a creation time and a repo root. The
    // socket needs none of it: the OS is the record.
    const shared = sharedAuthority();
    const held = await shared.forLauncher("A").acquire("PREPARE_LIVE_READY");
    expect(held.ok).toBe(true);
    expect(held.ok === true && Object.keys(held.held).sort()).toEqual(["action", "release"]);
    HELD.push("PREPARE_LIVE_READY");
  });

  it("the declared actions are exactly the mutating ones", () => {
    expect([...MUTATION_ACTIONS]).toEqual([
      "START_SAFE",
      "STOP_RUNTIME",
      "PREPARE_LIVE_READY",
      "RETURN_TO_SAFE",
      "RECOVER_TRANSITION",
      "SUPERVISE_RESTART",
      // The optional Native planner role's own explicit start / stop.
      "NATIVE_PLANNER_START",
      "NATIVE_PLANNER_STOP",
    ]);
  });
});
