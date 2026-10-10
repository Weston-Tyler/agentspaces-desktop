import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { existsSync } from "node:fs";
import {
  detectAnswerProviders,
  NativeAnswerProvider,
} from "../app/answer-provider.mjs";

test("revoked dispatch fence refuses inference after readiness without a native exec", async () => {
  const mock = fixture();
  const provider = new NativeAnswerProvider({
    provider: "codex",
    spawnProcess: mock.spawnProcess,
  });
  await assert.rejects(
    provider.answer({
      question: "Question",
      budget,
      beforeDispatch: () => {
        throw new Error("Source revoked");
      },
    }),
    (error) =>
      error.message === "Source revoked" && error.uncertainOutcome === false,
  );
  assert.equal(mock.calls.filter((call) => call.args[0] === "exec").length, 0);
});

const budget = {
  timeoutMs: 500,
  inputChars: 32000,
  outputChars: 16000,
  maxOutputTokens: 2000,
};
const events = [
  { type: "thread.started", thread_id: "native-thread" },
  { type: "turn.started", turn_id: "native-turn" },
  {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "An evidence based answer [source-1].",
    },
  },
  { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 12 } },
];
function fixture({
  answer = events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  code = 0,
  hang = false,
  codexVersion = "0.162.0-alpha.2",
  auth = true,
} = {}) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      child.emit("close", 143);
    };
    const call = { command, args, options, child, input: "" };
    calls.push(call);
    child.stdin = new Writable({
      write(chunk, _encoding, next) {
        call.input += chunk.toString();
        next();
      },
    });
    child.stdin.on("finish", () =>
      setImmediate(() => {
        if (args[0] === "--version") {
          child.stdout.write(
            command === "codex"
              ? "codex-cli " + codexVersion
              : "2.1.113 (Claude Code)",
          );
          child.emit("close", 0);
        } else if (args[0] === "login") {
          child.stderr.write("Native authentication status");
          child.emit("close", auth ? 0 : 1);
        } else if (command === "ssh" && call.input.includes("spawnSync")) {
          child.stdout.write(
            JSON.stringify([
              {
                provider: "codex",
                version: "codex-cli 0.161.0",
                authenticated: auth,
              },
              {
                provider: "claude",
                version: "2.1.283 (Claude Code)",
                authenticated: false,
              },
            ]),
          );
          child.emit("close", 0);
        } else if (!hang) {
          child.stdout.write(answer);
          child.emit("close", code);
        }
      }),
    );
    return child;
  };
  return { calls, spawnProcess };
}
const provider = (f) =>
  new NativeAnswerProvider({ provider: "codex", spawnProcess: f.spawnProcess });

test("fresh native answer parses identifiers and per-turn usage without prompt argv", async () => {
  const f = fixture();
  const result = await provider(f).answer({
    question: "What happened?",
    context: { id: "source-1", finding: "Done" },
    budget,
  });
  assert.equal(result.nativeThreadId, "native-thread");
  assert.equal(result.nativeTurnId, "native-turn");
  assert.equal(result.usage.totalTokens, 62);
  assert.equal(result.executionKind, "fresh-native-question");
  const call = f.calls.find((c) => c.args[0] === "exec");
  assert.ok(call.input.includes("What happened?"));
  assert.ok(!call.args.join(" ").includes("What happened?"));
  assert.ok(call.args.includes("--ephemeral"));
  assert.ok(call.args.includes("read-only"));
  assert.ok(call.args.includes("hooks"));
  assert.ok(call.args.includes("--ignore-user-config"));
  assert.equal(
    existsSync(call.options.cwd),
    false,
    "owned empty scratch removed after completion",
  );
});
test("budget validation and input bounds refuse before native dispatch", async () => {
  const f = fixture();
  await assert.rejects(provider(f).answer({ question: "Q" }), {
    code: "invalid_execution_budget",
    uncertainOutcome: false,
  });
  await assert.rejects(
    provider(f).answer({
      question: "Q",
      budget: { ...budget, timeoutMs: 120001 },
    }),
    { code: "invalid_execution_budget" },
  );
  await assert.rejects(
    provider(f).answer({ question: "Q".repeat(32000), budget }),
    { code: "input_budget_exceeded" },
  );
  assert.equal(f.calls.length, 0);
});
test("unqualified version and missing authentication refuse dispatch", async () => {
  const f = fixture({ codexVersion: "9.9.9" });
  await assert.rejects(provider(f).answer({ question: "Q", budget }), {
    code: "version_not_qualified",
  });
  assert.ok(!f.calls.some((c) => c.args[0] === "exec"));
  const g = fixture({ auth: false });
  await assert.rejects(provider(g).answer({ question: "Q", budget }), {
    code: "authentication_required",
  });
});
test("native failure diagnostics are not exposed or retained", async () => {
  const f = fixture({
    answer: '{"type":"turn.failed","error":{"message":"PRIVATE TOKEN"}}\n',
  });
  await assert.rejects(
    provider(f).answer({ question: "Q", budget }),
    (e) =>
      e.code === "native_turn_failed" &&
      e.uncertainOutcome &&
      !e.message.includes("PRIVATE"),
  );
});
test("unexpected native tool execution rejects the answer without killing the native process", async () => {
  const f = fixture({
    answer: '{"type":"item.started","item":{"type":"mcp_tool_call"}}\n',
  });
  await assert.rejects(provider(f).answer({ question: "Q", budget }), {
    code: "unexpected_native_tool_execution",
    uncertainOutcome: true,
  });
  assert.ok(!f.calls.at(-1).child.killed);
});
test("incomplete and malformed JSON events are uncertain failures", async () => {
  const f = fixture({ answer: "not JSON\n" });
  await assert.rejects(provider(f).answer({ question: "Q", budget }), {
    code: "native_protocol_error",
    uncertainOutcome: true,
  });
  const g = fixture({ answer: '{"type":"thread.started","thread_id":"x"}\n' });
  await assert.rejects(provider(g).answer({ question: "Q", budget }), {
    code: "native_answer_incomplete",
    uncertainOutcome: true,
  });
});
test("bounded answer text and native stdout fail closed without truncated success", async () => {
  const f = fixture({
    answer: events.map((e) => JSON.stringify(e)).join("\n"),
  });
  await assert.rejects(
    provider(f).answer({
      question: "Q",
      budget: { ...budget, outputChars: 8 },
    }),
    { code: "answer_output_budget_exceeded", uncertainOutcome: true },
  );
  const g = fixture({ answer: "x".repeat(140000) });
  await assert.rejects(provider(g).answer({ question: "Q", budget }), {
    code: "native_output_limit",
    uncertainOutcome: true,
  });
});
test("output token enforcement is explicitly after native completion", async () => {
  const f = fixture();
  await assert.rejects(
    provider(f).answer({
      question: "Q",
      budget: { ...budget, maxOutputTokens: 10 },
    }),
    { code: "answer_token_budget_exceeded", uncertainOutcome: true },
  );
});
test("timeout detaches observation and marks the dispatched outcome uncertain", async () => {
  const f = fixture({ hang: true });
  await assert.rejects(
    provider(f).answer({ question: "Q", budget: { ...budget, timeoutMs: 15 } }),
    { code: "native_timeout", uncertainOutcome: true },
  );
  assert.ok(!f.calls.at(-1).child.killed);
});
test("cancellation before dispatch is certain; cancellation during inference is uncertain", async () => {
  const f = fixture({ hang: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider(f).answer({ question: "Q", budget, signal: controller.signal }),
    { code: "cancelled", uncertainOutcome: false },
  );
  assert.equal(f.calls.length, 0);
  const next = new AbortController();
  const answer = provider(f).answer({
    question: "Q",
    budget,
    signal: next.signal,
  });
  const timer = setInterval(() => {
    if (f.calls.some((c) => c.args[0] === "exec")) {
      clearInterval(timer);
      next.abort();
    }
  }, 1);
  await assert.rejects(answer, { code: "cancelled", uncertainOutcome: true });
  assert.ok(!f.calls.at(-1).child.killed);
});
test("SSH uses fixed command with native prompt only on stdin and no remote process cancellation", async () => {
  const f = fixture();
  const p = new NativeAnswerProvider({
    provider: "codex",
    host: "remote",
    spawnProcess: f.spawnProcess,
  });
  const result = await p.answer({
    question: "Unique private question",
    budget,
  });
  assert.equal(result.host, "remote");
  const call = f.calls.at(-1);
  assert.deepEqual(call.args, ["remote", "node --input-type=module"]);
  assert.ok(!call.input.includes("child.kill"));
  assert.ok(!call.input.includes("setTimeout"));
  assert.ok(call.input.includes("child.stdin.end(p.prompt)"));
  assert.ok(!call.args.join(" ").includes("Unique private question"));
});
test("Claude consumer authentication is refused; API bare mode parses bounded fresh usage", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    const f = fixture();
    const p = new NativeAnswerProvider({
      provider: "claude",
      spawnProcess: f.spawnProcess,
    });
    await assert.rejects(
      p.answer({ question: "Q", budget: { ...budget, maxCostUsd: 0.1 } }),
      { code: "authentication_required" },
    );
    assert.ok(!f.calls.some((c) => c.args.includes("--print")));
    process.env.ANTHROPIC_API_KEY = "synthetic-test-presence-only";
    const g = fixture({
      answer: JSON.stringify({
        subtype: "success",
        result: "API answer",
        session_id: "claude-native",
        uuid: "result-id",
        usage: {
          input_tokens: 3,
          output_tokens: 5,
          cache_read_input_tokens: 2,
        },
      }),
    });
    const result = await new NativeAnswerProvider({
      provider: "claude",
      spawnProcess: g.spawnProcess,
    }).answer({ question: "Q", budget: { ...budget, maxCostUsd: 0.1 } });
    assert.equal(result.usage.totalTokens, 10);
    assert.equal(result.nativeThreadId, "claude-native");
    assert.ok(g.calls.at(-1).args.includes("--bare"));
    assert.ok(g.calls.at(-1).args.includes("--tools"));
    assert.ok(g.calls.at(-1).args.includes("--no-session-persistence"));
    assert.ok(g.calls.at(-1).args.includes("--max-budget-usd"));
    assert.ok(!g.calls.at(-1).args.includes("--resume"));
    await assert.rejects(
      new NativeAnswerProvider({
        provider: "claude",
        spawnProcess: g.spawnProcess,
      }).answer({ question: "Q", budget }),
      { code: "claude_api_cost_budget_required" },
    );
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});
test("availability exposes no credentials and known exec output may omit turn identity", async () => {
  const f = fixture();
  const availability = await detectAnswerProviders({
    spawnProcess: f.spawnProcess,
  });
  assert.equal(availability[0].available, true);
  assert.equal(availability[0].qualifiedVersion, "0.162.0-alpha.2");
  assert.ok(!JSON.stringify(availability).includes("TOKEN"));
  const g = fixture({
    answer: events
      .filter((e) => e.type !== "turn.started")
      .map((e) => JSON.stringify(e))
      .join("\n"),
  });
  const result = await provider(g).answer({ question: "Q", budget });
  assert.equal(result.nativeTurnId, null);
  assert.ok(
    result.limitations.some((s) => s.includes("identifier may be unavailable")),
  );
});

test('timed-out native answer keeps its scratch until the native process exits',async()=>{
 const f=fixture({hang:true});await assert.rejects(provider(f).answer({question:'Q',budget:{...budget,timeoutMs:15}}),{code:'native_timeout'});
 const call=f.calls.at(-1);assert.equal(existsSync(call.options.cwd),true);
 call.child.emit('close',0);
 for(let n=0;n<30&&existsSync(call.options.cwd);n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(existsSync(call.options.cwd),false);assert.ok(!call.child.killed);
});
