export type LineRow =
  | Readonly<{ kind: "add"; text: string; new: number }>
  | Readonly<{ kind: "del"; text: string; old: number }>
  | Readonly<{ kind: "ctx"; text: string; old: number; new: number }>;

export type HunkRow = Readonly<{
  kind: "hunk";
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  label: string;
}>;

export type DiffRow = LineRow | HunkRow;

export type FileDiff = Readonly<{
  path: string;
  rows: readonly DiffRow[];
  adds: number;
  dels: number;
}>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Walks hunks by their declared line counts so a removed line that starts with "-- " is not
 * mistaken for a file header.
 */
export function parsePatch(patch: string): FileDiff[] {
  const files: { path: string; rows: DiffRow[]; adds: number; dels: number }[] = [];
  let file: (typeof files)[number] | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\") || file === undefined) continue;
      const text = line.slice(1);
      if (line.startsWith("+") && newLeft > 0) {
        file.rows.push({ kind: "add", text, new: newNo++ });
        file.adds++;
        newLeft--;
      } else if (line.startsWith("-") && oldLeft > 0) {
        file.rows.push({ kind: "del", text, old: oldNo++ });
        file.dels++;
        oldLeft--;
      } else if (oldLeft > 0 && newLeft > 0 && (line.startsWith(" ") || line === "")) {
        file.rows.push({ kind: "ctx", text, old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const path = line.slice(line.lastIndexOf(" b/") + 3);
      file = { path, rows: [], adds: 0, dels: 0 };
      files.push(file);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null || file === undefined) continue;
    const [, oldStart, oldCount, newStart, newCount, label] = hunk;
    oldNo = Number(oldStart);
    newNo = Number(newStart);
    oldLeft = Number(oldCount ?? 1);
    newLeft = Number(newCount ?? 1);
    file.rows.push({
      kind: "hunk",
      oldStart: oldNo,
      oldCount: oldLeft,
      newStart: newNo,
      newCount: newLeft,
      label: label ?? "",
    });
  }
  return files;
}
