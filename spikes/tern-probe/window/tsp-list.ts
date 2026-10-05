// Native list from a plain Bun program over the Tern Surface Protocol (raw TSP, no library).
// Run inside a Tern pane: bun tsp-list.ts [tasks.json]. Click a row or press q. Events are logged to events.log.
import { appendFileSync, readFileSync } from "node:fs";

const TASKS = process.argv[2] ?? "/tmp/tern-window-test/tasks.json";
const LOG = "/tmp/tern-window-test/tsp-events.log";
const ESC = "\x1b";
const send = (verb: string, body: unknown) =>
  process.stdout.write(`${ESC}_tsp;${verb};${JSON.stringify(body)}${ESC}\\`);

type Task = { id: string; title: string; stage: string; needs?: string };
let seq = 0;
let mounted = false;
let last = "";

function items(tasks: Task[]) {
  return {
    id: "items",
    k: "list",
    c: tasks.map((t) => ({
      id: `t${t.id}`,
      k: "item",
      p: {
        label: t.title,
        detail: t.stage,
        value: t.needs ?? "",
        icon: t.needs ? "bell" : "check",
        tone: t.needs ? "warn" : undefined,
        actions: { click: `open=${t.id}` },
      },
    })),
  };
}

const root = (tasks: Task[]) => ({ id: "main", k: "col", c: [items(tasks)] });

function render() {
  const raw = readFileSync(TASKS, "utf8");
  if (raw === last) return;
  last = raw;
  const tasks = (JSON.parse(raw) as { tasks: Task[] }).tasks;
  seq += 1;
  const ops = mounted
    ? [
        ["del", "items"],
        ["add", "items", "main", null, items(tasks)],
      ]
    : [["add", "main", "tdm", null, root(tasks)]];
  send("f", { sf: "tdm", s: seq, ops });
  mounted = true;
}

process.stdin.setRawMode(true);
process.stdin.resume();
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  for (;;) {
    const m = /\x1b_tsp;e;([\s\S]*?)\x1b\\/.exec(buf);
    if (!m) break;
    buf = buf.slice(m.index + m[0].length);
    appendFileSync(LOG, `${Date.now()} ${m[1]}\n`);
  }
  if (buf.includes("q") && !buf.includes("_tsp")) quit();
});

function quit() {
  send("x", { id: "tdm", keep: false });
  process.exit(0);
}

send("q", { q: "hello", v: [1], app: "tandem-tsp-list" });
send("o", { id: "tdm", mode: "screen", title: "Tandem tasks (TSP)", role: "tandem.tasks" });
render();
setInterval(render, 500);
