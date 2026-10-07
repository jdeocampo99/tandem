import { dlopen, FFIType, ptr } from "bun:ffi";

/** Decode KERN_PROCARGS2's argc and argv only. Environment bytes are never returned. */
export function processArguments(bytes: Uint8Array): readonly string[] {
  const argc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
  if (argc < 1 || argc > 65_536) throw new Error("invalid native argument count");
  let cursor = 4;
  while (cursor < bytes.length && bytes[cursor] !== 0) cursor += 1;
  while (cursor < bytes.length && bytes[cursor] === 0) cursor += 1;
  const argv: string[] = [];
  for (let index = 0; index < argc; index += 1) {
    const end = bytes.indexOf(0, cursor);
    if (end < 0) throw new Error("truncated native arguments");
    argv.push(new TextDecoder().decode(bytes.subarray(cursor, end)));
    cursor = end + 1;
  }
  return argv;
}

/** This entrypoint prints only foreground group members' exact argv, never their environment. */
function foregroundGroup(group: number) {
  if (process.platform !== "darwin") throw new Error("Tern native process proof requires macOS");
  const listed = Bun.spawnSync(["/bin/ps", "-axo", "pid=,pgid=,comm="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) throw new Error("native process group listing failed");
  const members = listed.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match === null || Number(match[2]) !== group
        ? []
        : [{ pid: Number(match[1]), name: match[3] ?? "" }];
    });
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: {
      args: [
        FFIType.ptr,
        FFIType.uint32_t,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.uint64_t,
      ],
      returns: FFIType.int32_t,
    },
  });
  // A shell's prompt helpers come and go between `ps` and `sysctl`. One that exited, even if its
  // parent has not reaped it yet, is no longer running, so only a live member must give its argv.
  const gone = (pid: number) => {
    const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" });
    return state.exitCode !== 0 || state.stdout.toString().trim().startsWith("Z");
  };
  try {
    return members.flatMap((member) => {
      const mib = new Int32Array([1, 49, member.pid]); // CTL_KERN, KERN_PROCARGS2, pid
      const length = new BigUint64Array(1);
      if (library.symbols.sysctl(ptr(mib), mib.length, null, ptr(length), null, 0) !== 0) {
        if (gone(member.pid)) return [];
        throw new Error(`native argv unavailable for pid ${member.pid}`);
      }
      const size = Number(length[0]);
      if (!Number.isSafeInteger(size) || size < 4 || size > 16_777_216)
        throw new Error("invalid native argv buffer size");
      const bytes = new Uint8Array(size);
      if (library.symbols.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(length), null, 0) !== 0) {
        if (gone(member.pid)) return [];
        throw new Error(`native argv changed for pid ${member.pid}`);
      }
      const argv = processArguments(bytes.subarray(0, Number(length[0])));
      return [{ pid: member.pid, name: member.name.split("/").at(-1) ?? member.name, argv }];
    });
  } finally {
    library.close();
  }
}

if (import.meta.main) {
  const group = Number(process.argv[2]);
  if (!Number.isSafeInteger(group) || group < 1)
    throw new Error("a positive foreground group id is required");
  process.stdout.write(JSON.stringify(foregroundGroup(group)));
}
