# Tandem skills

Three optional conversational skills: `tandem` (how to use Tandem), `tandem-onboard` (add a
repository), and `tandem-status` (what tasks are doing). The `tandem` command does not need them.

## Install

Run this from the Tandem checkout root. It installs all three skills as absolute symlinks,
leaves a matching existing link intact, and refuses to overwrite any other destination:

```sh
TANDEM_ROOT="$(pwd -P)" bun -e '
import { lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.TANDEM_ROOT;
const home = process.env.HOME;
if (!root || !home) throw new Error("TANDEM_ROOT and HOME are required");
const roots = [join(home, ".agents/skills")];
if (process.env.INSTALL_CLAUDE === "1") roots.push(join(home, ".claude/skills"));
const names = ["tandem", "tandem-onboard", "tandem-status"];

for (const dir of roots) {
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    const source = join(root, "skills", name);
    const destination = join(dir, name);
    const sourceReal = await realpath(source);
    const existing = await lstat(destination).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      const matches = existing.isSymbolicLink() &&
        await realpath(destination).then((path) => path === sourceReal, () => false);
      if (!matches) throw new Error(`refusing to replace ${destination}`);
      continue;
    }
    await symlink(source, destination, "dir");
  }
}
'
```

The command above installs optional conversational skills for OMP/agents. Set `INSTALL_CLAUDE=1`
before the command to install the same links under `.claude/skills` as well. If the checkout moves,
the old links do not match; remove only links you own, then rerun the command. The linked
`tandem` executable remains the primary terminal front door.
