import { createInterface } from "node:readline";
import fs from "node:fs";
import cp from "node:child_process";
import net from "node:net";
if (process.argv[2] === "--probe") {
  const result = {};
  try {
    fs.readFileSync(process.argv[3]);
    result.file = "allowed";
  } catch (e) {
    result.file = e.code;
  }
  try {
    fs.writeFileSync(process.argv[3] + ".write", "forbidden");
    result.write = "allowed";
  } catch (e) {
    result.write = e.code;
  }
  try {
    cp.execFileSync(process.execPath, ["-e", "process.exit(0)"]);
    result.process = "allowed";
  } catch (e) {
    result.process = e.code;
  }
  await new Promise((resolve) => {
    const socket = net.connect(Number(process.argv[4]), "127.0.0.1");
    socket.once("error", (e) => {
      result.network = e.code;
      resolve();
    });
    socket.once("connect", () => {
      result.network = "allowed";
      socket.destroy();
      resolve();
    });
  });
  result.environment = Object.keys(process.env);
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
  await new Promise(() => {});
}
// Trusted interpreter. Source is a closed JSON language, never JavaScript, eval, vm or imports.
let initialized = false,
  allocation,
  program,
  generation,
  steps = 0,
  calls = 0;
const variables = new Map(),
  pending = new Map();
const send = (value, done) =>
  process.stdout.write(JSON.stringify(value) + "\n", done);
function budget() {
  if (++steps > allocation.maxSteps) throw new Error("CODE_MODE_STEP_LIMIT");
}
function bounded(value) {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > allocation.maxResultBytes)
    throw new Error("CODE_MODE_RESULT_LIMIT");
  return value;
}
function expr(x) {
  budget();
  switch (x.op) {
    case "literal":
      return bounded(x.value);
    case "var":
      if (!variables.has(x.name)) throw new Error("CODE_MODE_VARIABLE_MISSING");
      return variables.get(x.name);
    case "get": {
      const v = expr(x.value);
      if (
        !v ||
        typeof v !== "object" ||
        !Object.hasOwn(v, x.key) ||
        ["__proto__", "prototype", "constructor"].includes(x.key)
      )
        throw new Error("CODE_MODE_VALUE_INVALID");
      return v[x.key];
    }
    case "array":
      return bounded(x.items.map(expr));
    case "object": {
      const v = Object.create(null);
      for (const [k, e] of Object.entries(x.properties)) v[k] = expr(e);
      return bounded(v);
    }
    case "concat": {
      const a = expr(x.left),
        b = expr(x.right);
      if (typeof a !== "string" || typeof b !== "string")
        throw new Error("CODE_MODE_VALUE_INVALID");
      return bounded(a + b);
    }
    case "add": {
      const a = expr(x.left),
        b = expr(x.right);
      if (
        typeof a !== "number" ||
        typeof b !== "number" ||
        !Number.isFinite(a + b)
      )
        throw new Error("CODE_MODE_VALUE_INVALID");
      return a + b;
    }
    case "equal":
      return JSON.stringify(expr(x.left)) === JSON.stringify(expr(x.right));
    default:
      throw new Error("CODE_MODE_LANGUAGE_UNSUPPORTED");
  }
}
async function execute(list, path = "root") {
  for (let index = 0; index < list.length; index++) {
    budget();
    const x = list[index];
    switch (x.op) {
      case "let":
        variables.set(x.name, expr(x.value));
        break;
      case "call": {
        if (++calls > allocation.maxNestedCalls)
          throw new Error("CODE_MODE_CALL_LIMIT");
        const id = path + "-" + index + "-" + x.id,
          input = expr(x.input);
        const result = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          send({
            version: 1,
            type: "call",
            generation,
            id,
            tool: x.tool,
            input,
          });
        });
        variables.set(x.result, bounded(result));
        break;
      }
      case "if": {
        const condition = expr(x.condition);
        if (typeof condition !== "boolean")
          throw new Error("CODE_MODE_VALUE_INVALID");
        const value = await execute(
          condition ? x.then : x.else,
          path + "-" + index + "-branch",
        );
        if (value?.returned) return value;
        break;
      }
      case "repeat":
        for (let i = 0; i < x.count; i++) {
          variables.set(x.index, i);
          const value = await execute(x.body, path + "-" + index + "-" + i);
          if (value?.returned) return value;
        }
        break;
      case "return":
        return { returned: true, value: bounded(expr(x.value)) };
      default:
        throw new Error("CODE_MODE_LANGUAGE_UNSUPPORTED");
    }
  }
  return { returned: false, value: null };
}
createInterface({ input: process.stdin }).on("line", (line) => {
  if (Buffer.byteLength(line) > 65536) process.exit(2);
  let packet;
  try {
    packet = JSON.parse(line);
  } catch {
    process.exit(2);
  }
  if (!initialized) {
    if (packet.type !== "init" || packet.version !== 1) process.exit(2);
    initialized = true;
    allocation = packet.allocation;
    program = packet.program;
    generation = packet.generation;
    void execute(program.statements).then(
      (result) => {
        send(
          {
            version: 1,
            type: "result",
            generation,
            ok: true,
            value: result.value,
            steps,
            calls,
          },
          () => process.exit(0),
        );
      },
      (error) => {
        send(
          {
            version: 1,
            type: "result",
            generation,
            ok: false,
            errorCode: error.message,
            steps,
            calls,
          },
          () => process.exit(1),
        );
      },
    );
  } else {
    if (
      packet.type !== "reply" ||
      packet.generation !== generation ||
      !pending.has(packet.id)
    )
      process.exit(2);
    const call = pending.get(packet.id);
    pending.delete(packet.id);
    if (packet.ok) call.resolve(packet.result);
    else call.reject(new Error(packet.errorCode));
  }
});
