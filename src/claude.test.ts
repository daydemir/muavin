import { describe, expect, test } from "bun:test";
import { ClaudeProcessError, callClaudeWithSpawn } from "./claude";

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createFakeProcess(input: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  pid?: number;
  exitDelayMs?: number;
  waitForKill?: boolean;
}) {
  const writes: string[] = [];
  const kills: string[] = [];
  const exit = deferred<number>();

  if (!input.waitForKill) {
    setTimeout(() => exit.resolve(input.exitCode ?? 0), input.exitDelayMs ?? 0);
  }

  const proc = {
    stdout: textStream(input.stdout ?? ""),
    stderr: textStream(input.stderr ?? ""),
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
      },
      end() {},
    },
    exited: exit.promise,
    pid: input.pid ?? 1234,
    kill(signal?: string) {
      kills.push(signal ?? "SIGTERM");
      exit.resolve(input.exitCode ?? 1);
    },
  };

  return { proc, writes, kills };
}

describe("callClaudeWithSpawn", () => {
  test("returns parsed output and clears timeout before late kill", async () => {
    const { proc, writes, kills } = createFakeProcess({
      stdout: JSON.stringify({
        result: "hello",
        session_id: "sess_1",
        total_cost_usd: 0.1,
        duration_ms: 25,
      }),
      exitCode: 0,
      exitDelayMs: 5,
    });

    const result = await callClaudeWithSpawn(
      "Say hello",
      { timeoutMs: 40, model: "haiku" },
      () => proc,
    );

    expect(result.text).toBe("hello");
    expect(result.sessionId).toBe("sess_1");
    expect(writes).toEqual(["Say hello"]);
    await Bun.sleep(60);
    expect(kills).toEqual([]);
  });

  test("surfaces stdout when Claude exits without stderr", async () => {
    const makeProc = () => createFakeProcess({
      stdout: "permission denied from wrapper",
      stderr: "",
      exitCode: 1,
    }).proc;

    await expect(callClaudeWithSpawn("x", { cwd: "/tmp/muavin-test", model: "opus" }, makeProc)).rejects.toThrow(
      ClaudeProcessError,
    );

    try {
      await callClaudeWithSpawn("x", { cwd: "/tmp/muavin-test", model: "opus" }, makeProc);
    } catch (error) {
      const claudeError = error as ClaudeProcessError;
      expect(claudeError.message).toContain("Claude exited 1");
      expect(claudeError.message).toContain("stdout=permission denied from wrapper");
      expect(claudeError.message).toContain("cwd=/tmp/muavin-test");
    }
  });

  test("wraps invalid JSON output in ClaudeProcessError", async () => {
    const { proc } = createFakeProcess({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
    });

    try {
      await callClaudeWithSpawn("x", undefined, () => proc);
      throw new Error("expected invalid JSON failure");
    } catch (error) {
      const claudeError = error as ClaudeProcessError;
      expect(claudeError).toBeInstanceOf(ClaudeProcessError);
      expect(claudeError.message).toContain("Claude returned invalid JSON");
      expect(claudeError.message).toContain("stdout=not json");
    }
  });

  test("times out and sends SIGTERM without a late timeout race", async () => {
    const { proc, kills } = createFakeProcess({
      stdout: "",
      stderr: "",
      exitCode: 143,
      waitForKill: true,
    });

    try {
      await callClaudeWithSpawn("x", { timeoutMs: 15 }, () => proc);
      throw new Error("expected timeout");
    } catch (error) {
      const claudeError = error as ClaudeProcessError;
      expect(claudeError).toBeInstanceOf(ClaudeProcessError);
      expect(claudeError.timedOut).toBe(true);
      expect(claudeError.message).toContain("Claude timed out after 1s");
    }

    expect(kills).toEqual(["SIGTERM"]);
  });
});
