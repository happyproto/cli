// A port of the one call hpy makes into the Rust `similar` crate, version 3.2.1 (as pinned in
// Cargo.lock), for `hv pull --diff`:
//
//   similar::TextDiff::from_lines(&old, &new).unified_diff().context_radius(3).header(&a, &b)
//       .to_string()
//
// `unifiedDiff` reproduces that string byte for byte. The pieces it needs are ported here:
//
// - `DiffableStr::tokenize_lines` for `str` (src/text/abstraction.rs): lines keep their
//   terminator, and `\n`, `\r` and `\r\n` each end a line.
// - `TextDiffConfig::diff`/`capture_ops`/`capture_ops_pretrimmed` (src/text/mod.rs), with the
//   default `Algorithm::Myers`, no deadline and `WhitespaceMode::Exact`.
// - The heuristic Myers in src/algorithms/myers.rs: the preflight reduction of unmatched and
//   "confusing" records (src/algorithms/preflight.rs), prefix/suffix trimming, front-anchor
//   peeling, the small-side exact LCS fallback, and the Git-style bounded middle-snake search
//   (good-snake splits after cost 256, and a forced split at max(256, isqrt(N+M))). An exact
//   split switches both halves to raw mode; a heuristic split only the half before (forward) or
//   after (backward) it.
// - The `Compact` hook (src/algorithms/compact.rs: shifting deletes, then inserts, up and down
//   over equal runs, then cursor normalisation), `Replace` (src/algorithms/replace.rs) and
//   `Capture`.
// - `group_diff_ops` (src/common.rs) and the `UnifiedDiff` Display impls (src/udiff.rs).
//
// The deadline: `from_lines` sets none, so every `deadline_exceeded` check in the crate is
// `false` and is left out here. hpy's inputs are small, and the heuristic search bounds the
// work anyway.
//
// Lines are compared by interning them to integers. That stands in for both the crate's direct
// `str` comparisons (inputs of up to 100 lines) and its `IdentifyDistinct` remapping (more than
// 100): every comparison the crate makes is new-against-old or old-against-old, so any map that
// keeps line equality gives the same result, and nothing depends on hash values or map order.

/** `similar::DiffTag`. */
export type DiffTag = "equal" | "delete" | "insert" | "replace";

/**
 * `similar::DiffOp`. `oldLen` is `len` for an equal op and 0 for an insert; `newLen` is `len` for
 * an equal op and 0 for a delete.
 */
export interface DiffOp {
  tag: DiffTag;
  oldIndex: number;
  newIndex: number;
  oldLen: number;
  newLen: number;
}

type Seq = ArrayLike<number>;

function equalOp(oldIndex: number, newIndex: number, len: number): DiffOp {
  return { tag: "equal", oldIndex, newIndex, oldLen: len, newLen: len };
}

function oldEnd(op: DiffOp): number {
  return op.oldIndex + op.oldLen;
}

function newEnd(op: DiffOp): number {
  return op.newIndex + op.newLen;
}

function isEmptyOp(op: DiffOp): boolean {
  return op.oldLen <= 0 && op.newLen <= 0;
}

/** `DiffOp::adjust`: the offset moves both indexes; the length moves the op's own length(s). */
function adjust(op: DiffOp, offset: number, len: number): void {
  op.oldIndex += offset;
  op.newIndex += offset;
  switch (op.tag) {
    case "equal":
      op.oldLen += len;
      op.newLen = op.oldLen;
      break;
    case "delete":
      op.oldLen += len;
      break;
    case "insert":
      op.newLen += len;
      break;
    case "replace":
      op.oldLen += len;
      op.newLen += len;
      break;
  }
}

const shiftLeft = (op: DiffOp, n: number) => adjust(op, -n, 0);
const shiftRight = (op: DiffOp, n: number) => adjust(op, n, 0);
const growLeft = (op: DiffOp, n: number) => adjust(op, -n, n);
const growRight = (op: DiffOp, n: number) => adjust(op, 0, n);
const shrinkLeft = (op: DiffOp, n: number) => adjust(op, 0, -n);
const shrinkRight = (op: DiffOp, n: number) => adjust(op, n, -n);

/** `algorithms::DiffHook`. */
interface Hook {
  equal(oldIndex: number, newIndex: number, len: number): void;
  delete(oldIndex: number, oldLen: number, newIndex: number): void;
  insert(oldIndex: number, newIndex: number, newLen: number): void;
  replace(oldIndex: number, oldLen: number, newIndex: number, newLen: number): void;
  finish(): void;
}

/** `Capture`. */
class Capture implements Hook {
  ops: DiffOp[] = [];
  equal(oldIndex: number, newIndex: number, len: number): void {
    this.ops.push(equalOp(oldIndex, newIndex, len));
  }
  delete(oldIndex: number, oldLen: number, newIndex: number): void {
    this.ops.push({ tag: "delete", oldIndex, newIndex, oldLen, newLen: 0 });
  }
  insert(oldIndex: number, newIndex: number, newLen: number): void {
    this.ops.push({ tag: "insert", oldIndex, newIndex, oldLen: 0, newLen });
  }
  replace(oldIndex: number, oldLen: number, newIndex: number, newLen: number): void {
    this.ops.push({ tag: "replace", oldIndex, newIndex, oldLen, newLen });
  }
  finish(): void {}
}

/** `Replace`: merges equal runs, and a delete next to an insert into a replace. */
class Replace implements Hook {
  private del: [number, number, number] | undefined;
  private ins: [number, number, number] | undefined;
  private eq: [number, number, number] | undefined;
  private readonly d: Hook;
  constructor(d: Hook) {
    this.d = d;
  }

  private flushEq(): void {
    if (this.eq) {
      const [o, n, len] = this.eq;
      this.eq = undefined;
      this.d.equal(o, n, len);
    }
  }

  private flushDelIns(): void {
    if (this.del) {
      const [delOld, delLen, delNew] = this.del;
      this.del = undefined;
      if (this.ins) {
        const [, insNew, insLen] = this.ins;
        this.ins = undefined;
        this.d.replace(delOld, delLen, insNew, insLen);
      } else {
        this.d.delete(delOld, delLen, delNew);
      }
    } else if (this.ins) {
      const [insOld, insNew, insLen] = this.ins;
      this.ins = undefined;
      this.d.insert(insOld, insNew, insLen);
    }
  }

  equal(oldIndex: number, newIndex: number, len: number): void {
    this.flushDelIns();
    this.eq = this.eq ? [this.eq[0], this.eq[1], this.eq[2] + len] : [oldIndex, newIndex, len];
  }
  delete(oldIndex: number, oldLen: number, newIndex: number): void {
    this.flushEq();
    this.del = this.del
      ? [this.del[0], this.del[1] + oldLen, this.del[2]]
      : [oldIndex, oldLen, newIndex];
  }
  insert(oldIndex: number, newIndex: number, newLen: number): void {
    this.flushEq();
    this.ins = this.ins
      ? [this.ins[0], this.ins[1], newLen + this.ins[2]]
      : [oldIndex, newIndex, newLen];
  }
  replace(oldIndex: number, oldLen: number, newIndex: number, newLen: number): void {
    this.flushEq();
    this.d.replace(oldIndex, oldLen, newIndex, newLen);
  }
  finish(): void {
    this.flushEq();
    this.flushDelIns();
    this.d.finish();
  }
}

/** `NoFinishHook`. */
class NoFinish implements Hook {
  private readonly d: Hook;
  constructor(d: Hook) {
    this.d = d;
  }
  equal(o: number, n: number, len: number): void {
    this.d.equal(o, n, len);
  }
  delete(o: number, len: number, n: number): void {
    this.d.delete(o, len, n);
  }
  insert(o: number, n: number, len: number): void {
    this.d.insert(o, n, len);
  }
  replace(o: number, ol: number, n: number, nl: number): void {
    this.d.replace(o, ol, n, nl);
  }
  finish(): void {}
}

function commonPrefixLen(
  old: Seq,
  oldStart: number,
  oldEndIdx: number,
  new_: Seq,
  newStart: number,
  newEndIdx: number,
): number {
  if (oldStart >= oldEndIdx || newStart >= newEndIdx) return 0;
  const max = Math.min(oldEndIdx - oldStart, newEndIdx - newStart);
  let i = 0;
  while (i < max && new_[newStart + i] === old[oldStart + i]) i++;
  return i;
}

function commonSuffixLen(
  old: Seq,
  oldStart: number,
  oldEndIdx: number,
  new_: Seq,
  newStart: number,
  newEndIdx: number,
): number {
  if (oldStart >= oldEndIdx || newStart >= newEndIdx) return 0;
  const max = Math.min(oldEndIdx - oldStart, newEndIdx - newStart);
  let i = 0;
  while (i < max && new_[newEndIdx - 1 - i] === old[oldEndIdx - 1 - i]) i++;
  return i;
}

// ---------------------------------------------------------------------------------------------
// Compact (src/algorithms/compact.rs). The crate switches to a gap buffer above 64 ops; that is
// only a faster store with the same semantics, so a plain array is used throughout.

class Compact implements Hook {
  private ops: DiffOp[] = [];
  private readonly d: Hook;
  private readonly old: Seq;
  private readonly new_: Seq;
  constructor(d: Hook, old: Seq, new_: Seq) {
    this.d = d;
    this.old = old;
    this.new_ = new_;
  }
  equal(oldIndex: number, newIndex: number, len: number): void {
    this.ops.push(equalOp(oldIndex, newIndex, len));
  }
  delete(oldIndex: number, oldLen: number, newIndex: number): void {
    this.ops.push({ tag: "delete", oldIndex, newIndex, oldLen, newLen: 0 });
  }
  insert(oldIndex: number, newIndex: number, newLen: number): void {
    this.ops.push({ tag: "insert", oldIndex, newIndex, oldLen: 0, newLen });
  }
  // The trait's default `replace`.
  replace(oldIndex: number, oldLen: number, newIndex: number, newLen: number): void {
    this.delete(oldIndex, oldLen, newIndex);
    this.insert(oldIndex, newIndex, newLen);
  }
  finish(): void {
    shiftAllDiffOps(this.ops, this.old, this.new_);
    normalizeDiffOpCursors(this.ops);
    for (const op of this.ops) applyToHook(op, this.d);
    this.d.finish();
  }
}

function applyToHook(op: DiffOp, d: Hook): void {
  switch (op.tag) {
    case "equal":
      d.equal(op.oldIndex, op.newIndex, op.oldLen);
      break;
    case "delete":
      d.delete(op.oldIndex, op.oldLen, op.newIndex);
      break;
    case "insert":
      d.insert(op.oldIndex, op.newIndex, op.newLen);
      break;
    case "replace":
      d.replace(op.oldIndex, op.oldLen, op.newIndex, op.newLen);
      break;
  }
}

function shiftAllDiffOps(ops: DiffOp[], old: Seq, new_: Seq): void {
  for (const tag of ["delete", "insert"] as const) {
    let pointer = 0;
    while (pointer < ops.length) {
      if (ops[pointer]!.tag === tag) {
        pointer = shiftDiffOpsUp(ops, old, new_, pointer);
        pointer = shiftDiffOpsDown(ops, old, new_, pointer);
      }
      pointer += 1;
    }
  }
}

function normalizeDiffOpCursors(ops: DiffOp[]): void {
  let oldCursor = 0;
  let newCursor = 0;
  const first = ops[0];
  if (first) {
    oldCursor = first.oldIndex;
    newCursor = first.newIndex;
  }
  for (const op of ops) {
    switch (op.tag) {
      case "equal":
      case "replace":
        oldCursor = oldEnd(op);
        newCursor = newEnd(op);
        break;
      case "delete":
        op.newIndex = newCursor;
        oldCursor = oldEnd(op);
        break;
      case "insert":
        op.oldIndex = oldCursor;
        newCursor = newEnd(op);
        break;
    }
  }
}

function swapAdjacentInsertDelete(ops: DiffOp[], left: number): void {
  const right = left + 1;
  const oldStart = ops[left]!.oldIndex;
  const oldStop = oldEnd(ops[right]!);
  const newStart = ops[left]!.newIndex;
  const newStop = newEnd(ops[right]!);
  const tmp = ops[left]!;
  ops[left] = ops[right]!;
  ops[right] = tmp;
  const l = ops[left]!;
  if (l.tag === "insert") l.oldIndex = oldStart;
  else l.newIndex = newStart;
  const r = ops[right]!;
  if (r.tag === "insert") r.oldIndex = oldStop;
  else r.newIndex = newStop;
}

function shiftDiffOpsUp(ops: DiffOp[], old: Seq, new_: Seq, pointer: number): number {
  while (pointer >= 1 && pointer - 1 < ops.length) {
    const prevOp = { ...ops[pointer - 1]! };
    const thisOp = { ...ops[pointer]! };
    const pair = `${thisOp.tag}/${prevOp.tag}`;
    if (pair === "insert/equal" || pair === "delete/equal") {
      let suffixLen: number;
      let eqOld: number;
      let eqNew: number;
      if (pair === "insert/equal") {
        suffixLen = commonSuffixLen(
          old,
          prevOp.oldIndex,
          oldEnd(prevOp),
          new_,
          thisOp.newIndex,
          newEnd(thisOp),
        );
        eqOld = oldEnd(prevOp) - suffixLen;
        eqNew = newEnd(thisOp) - suffixLen;
      } else {
        if (!(pointer >= 2 && ops[pointer - 2]?.tag === "delete")) break;
        suffixLen = commonSuffixLen(
          old,
          thisOp.oldIndex,
          oldEnd(thisOp),
          new_,
          prevOp.newIndex,
          newEnd(prevOp),
        );
        eqOld = oldEnd(thisOp) - suffixLen;
        eqNew = newEnd(prevOp) - suffixLen;
      }
      if (suffixLen > 0) {
        const next = ops[pointer + 1];
        if (next?.tag === "equal") growLeft(next, suffixLen);
        else ops.splice(pointer + 1, 0, equalOp(eqOld, eqNew, suffixLen));
        shiftLeft(ops[pointer]!, suffixLen);
        shrinkLeft(ops[pointer - 1]!, suffixLen);
        if (isEmptyOp(ops[pointer - 1]!)) {
          ops.splice(pointer - 1, 1);
          pointer -= 1;
        }
      } else if (isEmptyOp(ops[pointer - 1]!)) {
        ops.splice(pointer - 1, 1);
        pointer -= 1;
      } else {
        break;
      }
    } else if (pair === "insert/delete" || pair === "delete/insert") {
      swapAdjacentInsertDelete(ops, pointer - 1);
      pointer -= 1;
    } else if (pair === "insert/insert") {
      growRight(ops[pointer - 1]!, thisOp.newLen);
      ops.splice(pointer, 1);
      pointer -= 1;
    } else if (pair === "delete/delete") {
      growRight(ops[pointer - 1]!, thisOp.oldLen);
      ops.splice(pointer, 1);
      pointer -= 1;
    } else {
      throw new Error("unexpected tag");
    }
  }
  return pointer;
}

function shiftDiffOpsDown(ops: DiffOp[], old: Seq, new_: Seq, pointer: number): number {
  while (pointer + 1 < ops.length) {
    const nextOp = { ...ops[pointer + 1]! };
    const thisOp = { ...ops[pointer]! };
    const pair = `${thisOp.tag}/${nextOp.tag}`;
    if (pair === "insert/equal" || pair === "delete/equal") {
      let prefixLen: number;
      let eqOld: number;
      if (pair === "insert/equal") {
        prefixLen = commonPrefixLen(
          old,
          nextOp.oldIndex,
          oldEnd(nextOp),
          new_,
          thisOp.newIndex,
          newEnd(thisOp),
        );
        eqOld = nextOp.oldIndex;
      } else {
        if (ops[pointer + 2]?.tag !== "delete") break;
        prefixLen = commonPrefixLen(
          old,
          thisOp.oldIndex,
          oldEnd(thisOp),
          new_,
          nextOp.newIndex,
          newEnd(nextOp),
        );
        eqOld = thisOp.oldIndex;
      }
      if (prefixLen > 0) {
        const prev = pointer >= 1 ? ops[pointer - 1] : undefined;
        if (prev?.tag === "equal") {
          growRight(prev, prefixLen);
        } else {
          ops.splice(pointer, 0, equalOp(eqOld, thisOp.newIndex, prefixLen));
          pointer += 1;
        }
        shiftRight(ops[pointer]!, prefixLen);
        shrinkRight(ops[pointer + 1]!, prefixLen);
        if (isEmptyOp(ops[pointer + 1]!)) ops.splice(pointer + 1, 1);
      } else if (isEmptyOp(ops[pointer + 1]!)) {
        ops.splice(pointer + 1, 1);
      } else {
        break;
      }
    } else if (pair === "insert/delete" || pair === "delete/insert") {
      swapAdjacentInsertDelete(ops, pointer);
      pointer += 1;
    } else if (pair === "insert/insert") {
      growRight(ops[pointer]!, nextOp.newLen);
      ops.splice(pointer + 1, 1);
    } else if (pair === "delete/delete") {
      growRight(ops[pointer]!, nextOp.oldLen);
      ops.splice(pointer + 1, 1);
    } else {
      throw new Error("unexpected tag");
    }
  }
  return pointer;
}

// ---------------------------------------------------------------------------------------------
// Preflight (src/algorithms/preflight.rs): `reduce_for_myers`.

const DISJOINT_FAST_PATH_MIN_LEN = 512;
const DISJOINT_FAST_PATH_MIN_WORK = 128 * 1024;
const DISJOINT_FAST_PATH_BOUNDARY_PROBE = 8;
const CONFUSING_RECORD_SCAN_WINDOW = 100;
const CONFUSING_RECORD_RATIO = 4;
const MAX_MATCH_FREQUENCY_THRESHOLD = 1024;
const NO_MATCH = -1;

interface Trimmed {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  origOldStart: number;
  origOldEnd: number;
  origNewStart: number;
  origNewEnd: number;
  prefixLen: number;
  suffixLen: number;
}

interface Reduced {
  oldValues: number[];
  oldIndices: number[];
  newValues: number[];
  newIndices: number[];
  trimmed: Trimmed;
}

function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

function shouldScan(
  old: Seq,
  oldStart: number,
  oldStop: number,
  new_: Seq,
  newStart: number,
  newStop: number,
): boolean {
  const oldLen = oldStop - oldStart;
  const newLen = newStop - newStart;
  if (
    oldLen < DISJOINT_FAST_PATH_MIN_LEN ||
    newLen < DISJOINT_FAST_PATH_MIN_LEN ||
    oldLen * newLen < DISJOINT_FAST_PATH_MIN_WORK
  ) {
    return false;
  }
  if (new_[newStart] === old[oldStart] || new_[newStop - 1] === old[oldStop - 1]) return false;
  const probeLen = Math.min(oldLen, newLen, DISJOINT_FAST_PATH_BOUNDARY_PROBE + 1);
  for (let skip = 1; skip < probeLen; skip++) {
    if (
      new_[newStart + skip] === old[oldStart] ||
      new_[newStart] === old[oldStart + skip] ||
      new_[newStop - 1 - skip] === old[oldStop - 1] ||
      new_[newStop - 1] === old[oldStop - 1 - skip]
    ) {
      return false;
    }
  }
  return true;
}

// `RecordAction`.
const Action = { Discard: 0, Keep: 1, Investigate: 2 } as const;
type Action = (typeof Action)[keyof typeof Action];

function recordActions(ids: number[], oppositeCounts: number[]): Action[] {
  const limit = Math.min(Math.max(isqrt(ids.length), 1), MAX_MATCH_FREQUENCY_THRESHOLD);
  return ids.map((id) => {
    if (id === NO_MATCH) return Action.Discard;
    const count = oppositeCounts[id]!;
    if (count === 0) return Action.Discard;
    return count < limit ? Action.Keep : Action.Investigate;
  });
}

function scanConfusingRun(actions: Action[], start: number, step: 1 | -1): [number, number] {
  let discards = 0;
  let investigates = 0;
  let index = start;
  for (let taken = 0; taken < CONFUSING_RECORD_SCAN_WINDOW; taken++) {
    if (index < 0 || index >= actions.length) break;
    const a = actions[index]!;
    if (a === Action.Discard) discards++;
    else if (a === Action.Investigate) investigates++;
    else break;
    index += step;
  }
  return [discards, investigates];
}

function discardConfusingRecord(actions: Action[], index: number): boolean {
  const [leftDiscards, leftInvestigates] = scanConfusingRun(actions, index - 1, -1);
  if (leftDiscards === 0) return false;
  const [rightDiscards, rightInvestigates] = scanConfusingRun(actions, index + 1, 1);
  if (rightDiscards === 0) return false;
  const discards = leftDiscards + rightDiscards;
  const investigates = leftInvestigates + rightInvestigates + 1;
  return investigates * CONFUSING_RECORD_RATIO < investigates + discards;
}

function keepRecord(actions: Action[], index: number): boolean {
  const a = actions[index]!;
  if (a === Action.Discard) return false;
  if (a === Action.Keep) return true;
  return !discardConfusingRecord(actions, index);
}

function reduceForMyers(
  old: Seq,
  oldStart0: number,
  oldEnd0: number,
  new_: Seq,
  newStart0: number,
  newEnd0: number,
): { kind: "trimmed"; trimmed: Trimmed } | { kind: "reduced"; reduced: Reduced } {
  const prefixLen = commonPrefixLen(old, oldStart0, oldEnd0, new_, newStart0, newEnd0);
  const suffixLen = commonSuffixLen(
    old,
    oldStart0 + prefixLen,
    oldEnd0,
    new_,
    newStart0 + prefixLen,
    newEnd0,
  );
  const trimmed: Trimmed = {
    oldStart: oldStart0 + prefixLen,
    oldEnd: oldEnd0 - suffixLen,
    newStart: newStart0 + prefixLen,
    newEnd: newEnd0 - suffixLen,
    origOldStart: oldStart0,
    origOldEnd: oldEnd0,
    origNewStart: newStart0,
    origNewEnd: newEnd0,
    prefixLen,
    suffixLen,
  };
  const { oldStart, oldEnd: oldStop, newStart, newEnd: newStop } = trimmed;
  if (!shouldScan(old, oldStart, oldStop, new_, newStart, newStop)) {
    return { kind: "trimmed", trimmed };
  }

  // Ids in order of first appearance in old; equality is all that matters.
  const byValue = new Map<number, number>();
  const oldValues: number[] = [];
  const newValues: number[] = [];
  const oldCounts: number[] = [];
  const newCounts: number[] = [];
  for (let i = oldStart; i < oldStop; i++) {
    const v = old[i]!;
    let id = byValue.get(v);
    if (id === undefined) {
      id = oldCounts.length;
      byValue.set(v, id);
      oldCounts.push(0);
      newCounts.push(0);
    }
    oldCounts[id]! += 1;
    oldValues.push(id);
  }
  for (let i = newStart; i < newStop; i++) {
    const id = byValue.get(new_[i]!) ?? NO_MATCH;
    if (id !== NO_MATCH) newCounts[id]! += 1;
    newValues.push(id);
  }

  const oldActions = recordActions(oldValues, newCounts);
  const reducedOld: number[] = [];
  const oldIndices: number[] = [];
  for (let offset = 0; offset < oldValues.length; offset++) {
    if (keepRecord(oldActions, offset)) {
      reducedOld.push(oldValues[offset]!);
      oldIndices.push(oldStart + offset);
    }
  }
  const newActions = recordActions(newValues, oldCounts);
  const reducedNew: number[] = [];
  const newIndices: number[] = [];
  for (let offset = 0; offset < newValues.length; offset++) {
    if (keepRecord(newActions, offset)) {
      reducedNew.push(newValues[offset]!);
      newIndices.push(newStart + offset);
    }
  }
  if (oldIndices.length === oldStop - oldStart && newIndices.length === newStop - newStart) {
    return { kind: "trimmed", trimmed };
  }
  return {
    kind: "reduced",
    reduced: {
      oldValues: reducedOld,
      oldIndices,
      newValues: reducedNew,
      newIndices,
      trimmed,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Myers (src/algorithms/myers.rs).

// `MyersMode`.
const Mode = { Heuristic: 0, Raw: 1 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

/** `myers::diff_deadline` with no deadline. */
function myersDiff(
  d: Hook,
  old: Seq,
  oldStart: number,
  oldStop: number,
  new_: Seq,
  newStart: number,
  newStop: number,
): void {
  const pre = reduceForMyers(old, oldStart, oldStop, new_, newStart, newStop);
  if (pre.kind === "reduced") diffReduced(d, pre.reduced);
  else diffPretrimmed(d, old, new_, pre.trimmed, Mode.Heuristic);
}

/** `ReducedDiffHook`: maps equal runs of the reduced sequences back to the originals. */
class ReducedHook implements Hook {
  private oldCursor: number;
  private newCursor: number;
  private readonly d: Hook;
  private readonly oldIndices: number[];
  private readonly newIndices: number[];
  private readonly oldStop: number;
  private readonly newStop: number;
  constructor(
    d: Hook,
    oldIndices: number[],
    newIndices: number[],
    oldStart: number,
    newStart: number,
    oldStop: number,
    newStop: number,
  ) {
    this.d = d;
    this.oldIndices = oldIndices;
    this.newIndices = newIndices;
    this.oldCursor = oldStart;
    this.newCursor = newStart;
    this.oldStop = oldStop;
    this.newStop = newStop;
  }
  private emitGaps(oldAnchor: number, newAnchor: number): void {
    if (this.oldCursor < oldAnchor) {
      this.d.delete(this.oldCursor, oldAnchor - this.oldCursor, this.newCursor);
      this.oldCursor = oldAnchor;
    }
    if (this.newCursor < newAnchor) {
      this.d.insert(this.oldCursor, this.newCursor, newAnchor - this.newCursor);
      this.newCursor = newAnchor;
    }
  }
  equal(oldIndex: number, newIndex: number, len: number): void {
    let offset = 0;
    while (offset < len) {
      const oldAnchor = this.oldIndices[oldIndex + offset]!;
      const newAnchor = this.newIndices[newIndex + offset]!;
      this.emitGaps(oldAnchor, newAnchor);
      let run = 1;
      while (
        offset + run < len &&
        this.oldIndices[oldIndex + offset + run] === oldAnchor + run &&
        this.newIndices[newIndex + offset + run] === newAnchor + run
      ) {
        run++;
      }
      this.d.equal(oldAnchor, newAnchor, run);
      this.oldCursor = oldAnchor + run;
      this.newCursor = newAnchor + run;
      offset += run;
    }
  }
  delete(): void {}
  insert(): void {}
  // The trait's default `replace` calls `delete` and `insert`, which do nothing here.
  replace(): void {}
  finish(): void {
    this.emitGaps(this.oldStop, this.newStop);
  }
}

function diffReduced(d: Hook, reduced: Reduced): void {
  const t = reduced.trimmed;
  if (t.prefixLen > 0) d.equal(t.origOldStart, t.origNewStart, t.prefixLen);
  const hook = new ReducedHook(
    d,
    reduced.oldIndices,
    reduced.newIndices,
    t.oldStart,
    t.newStart,
    t.oldEnd,
    t.newEnd,
  );
  diffImpl(
    hook,
    reduced.oldValues,
    0,
    reduced.oldValues.length,
    reduced.newValues,
    0,
    reduced.newValues.length,
    Mode.Heuristic,
  );
  if (t.suffixLen > 0) {
    d.equal(t.origOldEnd - t.suffixLen, t.origNewEnd - t.suffixLen, t.suffixLen);
  }
  d.finish();
}

function diffImpl(
  d: Hook,
  old: Seq,
  oldStart: number,
  oldStop: number,
  new_: Seq,
  newStart: number,
  newStop: number,
  mode: Mode,
): void {
  const prefixLen = commonPrefixLen(old, oldStart, oldStop, new_, newStart, newStop);
  const suffixLen = commonSuffixLen(
    old,
    oldStart + prefixLen,
    oldStop,
    new_,
    newStart + prefixLen,
    newStop,
  );
  diffPretrimmed(
    d,
    old,
    new_,
    {
      oldStart: oldStart + prefixLen,
      oldEnd: oldStop - suffixLen,
      newStart: newStart + prefixLen,
      newEnd: newStop - suffixLen,
      origOldStart: oldStart,
      origOldEnd: oldStop,
      origNewStart: newStart,
      origNewEnd: newStop,
      prefixLen,
      suffixLen,
    },
    mode,
  );
}

/** `V`: furthest-reaching x per diagonal, indexed from `-offset`. */
class V {
  private readonly v: Float64Array;
  private readonly offset: number;
  constructor(offset: number) {
    this.offset = offset;
    this.v = new Float64Array(2 * offset);
  }
  get(k: number): number {
    const i = k + this.offset;
    if (i < 0 || i >= this.v.length) throw new Error("index out of bounds");
    return this.v[i]!;
  }
  set(k: number, x: number): void {
    const i = k + this.offset;
    if (i < 0 || i >= this.v.length) throw new Error("index out of bounds");
    this.v[i] = x;
  }
}

function maxD(len1: number, len2: number): number {
  return Math.ceil((len1 + len2) / 2) + 1;
}

function diffPretrimmed(d: Hook, old: Seq, new_: Seq, t: Trimmed, mode: Mode): void {
  if (t.prefixLen > 0) d.equal(t.origOldStart, t.origNewStart, t.prefixLen);
  const oldEmpty = t.oldStart >= t.oldEnd;
  const newEmpty = t.newStart >= t.newEnd;
  if (oldEmpty && newEmpty) {
    // Nothing to emit.
  } else if (oldEmpty) {
    d.insert(t.oldStart, t.newStart, t.newEnd - t.newStart);
  } else if (newEmpty) {
    d.delete(t.oldStart, t.oldEnd - t.oldStart, t.newStart);
  } else {
    const max = maxD(t.oldEnd - t.oldStart, t.newEnd - t.newStart);
    const vb = new V(max);
    const vf = new V(max);
    conquer(d, old, t.oldStart, t.oldEnd, new_, t.newStart, t.newEnd, vf, vb, mode);
  }
  if (t.suffixLen > 0) {
    d.equal(t.origOldEnd - t.suffixLen, t.origNewEnd - t.suffixLen, t.suffixLen);
  }
  d.finish();
}

const SMALL_SIDE_EXACT_MAX = 64;
const SMALL_SIDE_EXACT_MIN_LARGE = 512;
const SMALL_SIDE_EXACT_MAX_WORK = 64_000_000;
const HEURISTIC_MIN_COST = 256;
const HEURISTIC_MIN_SNAKE = 20;
const HEURISTIC_MIN_MAX_COST = 256;
const HEURISTIC_PROGRESS_FACTOR = 4;

function maybeEmitSmallSideExact(
  d: Hook,
  old: Seq,
  oldStart: number,
  oldStop: number,
  new_: Seq,
  newStart: number,
  newStop: number,
): boolean {
  const oldLen = oldStop - oldStart;
  const newLen = newStop - newStart;
  const small = Math.min(oldLen, newLen);
  const large = Math.max(oldLen, newLen);
  if (
    small === 0 ||
    small > SMALL_SIDE_EXACT_MAX ||
    large < SMALL_SIDE_EXACT_MIN_LARGE ||
    oldLen * newLen > SMALL_SIDE_EXACT_MAX_WORK
  ) {
    return false;
  }
  if (oldLen <= newLen) emitSmallOldExact(d, old, oldStart, oldLen, new_, newStart, newLen);
  else emitSmallNewExact(d, old, oldStart, oldLen, new_, newStart, newLen);
  return true;
}

/**
 * `emit_small_old_exact` and `emit_small_new_exact` are the same walk with the roles of the two
 * sides swapped: `a` is the short side (the dp's rows) and `b` the long one. `aIsOld` says which
 * Rust function this is, which decides how the walk's runs map back to delete and insert.
 */
function emitSmallExact(
  d: Hook,
  a: Seq,
  aStart: number,
  n: number,
  b: Seq,
  bStart: number,
  m: number,
  aIsOld: boolean,
): void {
  const width = m + 1;
  const dp = new Uint8Array((n + 1) * width);
  const eq = (i: number, j: number) => a[aStart + i] === b[bStart + j];
  for (let i = n - 1; i >= 0; i--) {
    const row = i * width;
    const next = (i + 1) * width;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = eq(i, j) ? dp[next + j + 1]! + 1 : Math.max(dp[next + j]!, dp[row + j + 1]!);
    }
  }
  const diag = (i: number, j: number) =>
    eq(i, j) && dp[i * width + j] === dp[(i + 1) * width + j + 1]! + 1;
  // Advance on the short side (a delete when it is old, an insert when it is new).
  const emitA = (start: number, len: number, bAt: number) => {
    if (aIsOld) d.delete(aStart + start, len, bStart + bAt);
    else d.insert(bStart + bAt, aStart + start, len);
  };
  const emitB = (aAt: number, start: number, len: number) => {
    if (aIsOld) d.insert(aStart + aAt, bStart + start, len);
    else d.delete(bStart + start, len, aStart + aAt);
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (diag(i, j)) {
      const si = i;
      const sj = j;
      while (i < n && j < m && diag(i, j)) {
        i++;
        j++;
      }
      if (aIsOld) d.equal(aStart + si, bStart + sj, i - si);
      else d.equal(bStart + sj, aStart + si, j - sj);
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      const si = i;
      const bAt = j;
      while (i < n) {
        if (j >= m) {
          i = n;
          break;
        }
        if (diag(i, j)) break;
        if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) i++;
        else break;
      }
      emitA(si, i - si, bAt);
    } else {
      const sj = j;
      const aAt = i;
      while (j < m) {
        if (i >= n) {
          j = m;
          break;
        }
        if (diag(i, j)) break;
        if (dp[(i + 1) * width + j]! < dp[i * width + j + 1]!) j++;
        else break;
      }
      emitB(aAt, sj, j - sj);
    }
  }
  // The tail emits the old side's remainder first, whichever side that is.
  if (aIsOld) {
    if (i < n) emitA(i, n - i, j);
    if (j < m) emitB(i, j, m - j);
  } else {
    if (j < m) emitB(i, j, m - j);
    if (i < n) emitA(i, n - i, j);
  }
}

function emitSmallOldExact(
  d: Hook,
  old: Seq,
  oldStart: number,
  n: number,
  new_: Seq,
  newStart: number,
  m: number,
): void {
  emitSmallExact(d, old, oldStart, n, new_, newStart, m, true);
}

function emitSmallNewExact(
  d: Hook,
  old: Seq,
  oldStart: number,
  n: number,
  new_: Seq,
  newStart: number,
  m: number,
): void {
  emitSmallExact(d, new_, newStart, m, old, oldStart, n, false);
}

interface Range {
  start: number;
  end: number;
}

function tryEmitFrontAnchor(d: Hook, old: Seq, oldR: Range, new_: Seq, newR: Range): void {
  const MAX_SKIP = 4;
  const MIN_ANCHOR_COMMON = 96;
  const oldLen = oldR.end - oldR.start;
  const newLen = newR.end - newR.start;
  if (oldLen <= MIN_ANCHOR_COMMON || newLen <= MIN_ANCHOR_COMMON) return;
  const small = Math.min(oldLen, newLen);
  const large = Math.max(oldLen, newLen);
  if (large < small * 2) return;
  const maxOldSkip = Math.min(Math.max(oldLen - 1, 0), MAX_SKIP);
  const maxNewSkip = Math.min(Math.max(newLen - 1, 0), MAX_SKIP);
  const preferInsert = newLen > oldLen;
  const preferDelete = oldLen > newLen;

  let best: [number, number, number] | undefined;
  search: for (let oldSkip = 0; oldSkip <= maxOldSkip; oldSkip++) {
    for (let newSkip = 0; newSkip <= maxNewSkip; newSkip++) {
      if (oldSkip === 0 && newSkip === 0) continue;
      if (oldSkip !== 0 && newSkip !== 0) continue;
      if (preferInsert && oldSkip !== 0) continue;
      if (preferDelete && newSkip !== 0) continue;
      if (new_[newR.start + newSkip] !== old[oldR.start + oldSkip]) continue;
      const common = commonPrefixLen(
        old,
        oldR.start + oldSkip,
        oldR.end,
        new_,
        newR.start + newSkip,
        newR.end,
      );
      if (common >= MIN_ANCHOR_COMMON) {
        if (common >= MIN_ANCHOR_COMMON * 8) {
          best = [oldSkip, newSkip, common];
          break search;
        }
        // Compare (common, Reverse(span), old_skip, new_skip) lexicographically.
        let better = true;
        if (best) {
          const [bo, bn, bc] = best;
          const span = Math.max(oldSkip, newSkip);
          const bspan = Math.max(bo, bn);
          if (common !== bc) better = common > bc;
          else if (span !== bspan) better = span < bspan;
          else if (oldSkip !== bo) better = oldSkip > bo;
          else better = newSkip > bn;
        }
        if (better) best = [oldSkip, newSkip, common];
      }
    }
  }
  if (!best) return;
  const [oldSkip, newSkip, common] = best;
  if (oldSkip === 0 && newSkip !== 0) d.insert(oldR.start, newR.start, newSkip);
  else if (oldSkip !== 0 && newSkip === 0) d.delete(oldR.start, oldSkip, newR.start);
  else if (oldSkip !== 0 && newSkip !== 0) d.replace(oldR.start, oldSkip, newR.start, newSkip);
  d.equal(oldR.start + oldSkip, newR.start + newSkip, common);
  oldR.start += oldSkip + common;
  newR.start += newSkip + common;
}

interface HeuristicSplit {
  oldIndex: number;
  newIndex: number;
  progress: number;
  forward: boolean;
}

interface MiddleSnakeSplit {
  oldIndex: number;
  newIndex: number;
  leftMode: Mode;
  rightMode: Mode;
}

function exactSplit(oldIndex: number, newIndex: number): MiddleSnakeSplit {
  return { oldIndex, newIndex, leftMode: Mode.Raw, rightMode: Mode.Raw };
}

function heuristicSplit(s: HeuristicSplit, oldStart: number, newStart: number): MiddleSnakeSplit {
  return {
    oldIndex: oldStart + s.oldIndex,
    newIndex: newStart + s.newIndex,
    leftMode: s.forward ? Mode.Raw : Mode.Heuristic,
    rightMode: s.forward ? Mode.Heuristic : Mode.Raw,
  };
}

function better(best: HeuristicSplit | undefined, candidate: HeuristicSplit): HeuristicSplit {
  return best === undefined || candidate.progress > best.progress ? candidate : best;
}

function isInteriorSplit(oi: number, ni: number, oldLen: number, newLen: number): boolean {
  return oi <= oldLen && ni <= newLen && (oi !== 0 || ni !== 0) && (oi !== oldLen || ni !== newLen);
}

function clampDiagonalPoint(
  oldIndex: number,
  diagonal: number,
  oldLen: number,
  newLen: number,
): [number, number] | undefined {
  if (diagonal < 0 && -diagonal > newLen) return undefined;
  const minOld = Math.max(diagonal, 0);
  const maxOld =
    diagonal >= 0
      ? Math.min(oldLen, newLen + diagonal)
      : Math.min(oldLen, Math.max(newLen + diagonal, 0));
  if (minOld > maxOld) return undefined;
  const o = Math.min(Math.max(oldIndex, minOld), maxOld);
  return [o, o - diagonal];
}

function findMiddleSnake(
  old: Seq,
  oldStart: number,
  oldStop: number,
  new_: Seq,
  newStart: number,
  newStop: number,
  vf: V,
  vb: V,
  mode: Mode,
): MiddleSnakeSplit | undefined {
  const n = oldStop - oldStart;
  const m = newStop - newStart;
  const delta = n - m;
  // Rust's `delta & 1 == 1` on an isize: true for odd deltas of either sign.
  const odd = (delta & 1) === 1;
  vf.set(1, 0);
  vb.set(1, 0);
  const dMax = maxD(n, m);
  const maxCost =
    mode === Mode.Heuristic
      ? Math.max(isqrt(n + m), HEURISTIC_MIN_MAX_COST)
      : Number.POSITIVE_INFINITY;

  for (let d = 0; d < dMax; d++) {
    let goodSplit: HeuristicSplit | undefined;
    let forwardSplit: HeuristicSplit | undefined;
    let backwardSplit: HeuristicSplit | undefined;
    const trackLimit = mode === Mode.Heuristic && d >= maxCost;
    const trackGood = mode === Mode.Heuristic && d > HEURISTIC_MIN_COST;

    for (let k = d; k >= -d; k -= 2) {
      let x =
        k === -d || (k !== d && vf.get(k - 1) < vf.get(k + 1)) ? vf.get(k + 1) : vf.get(k - 1) + 1;
      const y = x - k;
      const x0 = x;
      const y0 = y;
      if (x < n && y < m) {
        x += commonPrefixLen(old, oldStart + x, oldStop, new_, newStart + y, newStop);
      }
      const snakeLen = x - x0;
      vf.set(k, x);
      if (odd && Math.abs(k - delta) <= d - 1 && vf.get(k) + vb.get(-(k - delta)) >= n) {
        return exactSplit(x0 + oldStart, y0 + newStart);
      }
      if (trackLimit) {
        const p = clampDiagonalPoint(x, k, n, m);
        if (p && isInteriorSplit(p[0], p[1], n, m)) {
          forwardSplit = better(forwardSplit, {
            oldIndex: p[0],
            newIndex: p[1],
            progress: p[0] + p[1],
            forward: true,
          });
        }
      }
      // `y` is still the snake's start row here, as in the crate.
      if (trackGood && snakeLen >= HEURISTIC_MIN_SNAKE && x < n && y < m) {
        const useful = Math.max(x + y - Math.abs(k), 0);
        if (useful > HEURISTIC_PROGRESS_FACTOR * d && isInteriorSplit(x0, y0, n, m)) {
          goodSplit = better(goodSplit, {
            oldIndex: x0,
            newIndex: y0,
            progress: useful,
            forward: true,
          });
        }
      }
    }

    for (let k = d; k >= -d; k -= 2) {
      let x =
        k === -d || (k !== d && vb.get(k - 1) < vb.get(k + 1)) ? vb.get(k + 1) : vb.get(k - 1) + 1;
      let y = x - k;
      const x0 = x;
      if (x < n && y < m) {
        const advance = commonSuffixLen(
          old,
          oldStart,
          oldStart + n - x,
          new_,
          newStart,
          newStart + m - y,
        );
        x += advance;
        y += advance;
      }
      const snakeLen = x - x0;
      vb.set(k, x);
      if (!odd && Math.abs(k - delta) <= d && vb.get(k) + vf.get(-(k - delta)) >= n) {
        return exactSplit(n - x + oldStart, m - y + newStart);
      }
      if (trackLimit) {
        const p = clampDiagonalPoint(x, k, n, m);
        if (p) {
          const so = n - p[0];
          const sn = m - p[1];
          if (isInteriorSplit(so, sn, n, m)) {
            backwardSplit = better(backwardSplit, {
              oldIndex: so,
              newIndex: sn,
              progress: p[0] + p[1],
              forward: false,
            });
          }
        }
      }
      if (trackGood && snakeLen >= HEURISTIC_MIN_SNAKE && x <= n && y <= m) {
        const so = n - x;
        const sn = m - y;
        const useful = Math.max(x + y - Math.abs(k), 0);
        if (so > 0 && sn > 0 && useful > HEURISTIC_PROGRESS_FACTOR * d) {
          goodSplit = better(goodSplit, {
            oldIndex: so,
            newIndex: sn,
            progress: useful,
            forward: false,
          });
        }
      }
    }

    if (goodSplit) return heuristicSplit(goodSplit, oldStart, newStart);
    if (d >= maxCost) {
      let split: HeuristicSplit;
      if (forwardSplit && backwardSplit) {
        split = forwardSplit.progress > backwardSplit.progress ? forwardSplit : backwardSplit;
      } else if (forwardSplit || backwardSplit) {
        split = (forwardSplit ?? backwardSplit)!;
      } else {
        break;
      }
      return heuristicSplit(split, oldStart, newStart);
    }
  }
  return undefined;
}

function conquer(
  d: Hook,
  old: Seq,
  oldStart: number,
  oldStop: number,
  new_: Seq,
  newStart: number,
  newStop: number,
  vf: V,
  vb: V,
  mode: Mode,
): void {
  const oldR: Range = { start: oldStart, end: oldStop };
  const newR: Range = { start: newStart, end: newStop };
  const prefix = commonPrefixLen(old, oldR.start, oldR.end, new_, newR.start, newR.end);
  if (prefix > 0) d.equal(oldR.start, newR.start, prefix);
  oldR.start += prefix;
  newR.start += prefix;

  const suffix = commonSuffixLen(old, oldR.start, oldR.end, new_, newR.start, newR.end);
  const suffixAt: [number, number] = [oldR.end - suffix, newR.end - suffix];
  oldR.end -= suffix;
  newR.end -= suffix;

  while (oldR.start < oldR.end && newR.start < newR.end) {
    const ob = oldR.start;
    const nb = newR.start;
    tryEmitFrontAnchor(d, old, oldR, new_, newR);
    if (oldR.start === ob && newR.start === nb) break;
  }

  const oldEmpty = oldR.start >= oldR.end;
  const newEmpty = newR.start >= newR.end;
  if (oldEmpty && newEmpty) {
    // Nothing.
  } else if (newEmpty) {
    d.delete(oldR.start, oldR.end - oldR.start, newR.start);
  } else if (oldEmpty) {
    d.insert(oldR.start, newR.start, newR.end - newR.start);
  } else if (maybeEmitSmallSideExact(d, old, oldR.start, oldR.end, new_, newR.start, newR.end)) {
    // The exact fallback emitted the script.
  } else {
    const split = findMiddleSnake(
      old,
      oldR.start,
      oldR.end,
      new_,
      newR.start,
      newR.end,
      vf,
      vb,
      mode,
    );
    if (split) {
      conquer(
        d,
        old,
        oldR.start,
        split.oldIndex,
        new_,
        newR.start,
        split.newIndex,
        vf,
        vb,
        split.leftMode,
      );
      conquer(
        d,
        old,
        split.oldIndex,
        oldR.end,
        new_,
        split.newIndex,
        newR.end,
        vf,
        vb,
        split.rightMode,
      );
    } else {
      d.delete(oldR.start, oldR.end - oldR.start, newR.start);
      d.insert(oldR.start, newR.start, newR.end - newR.start);
    }
  }
  if (suffix > 0) d.equal(suffixAt[0], suffixAt[1], suffix);
}

// ---------------------------------------------------------------------------------------------
// TextDiff (src/text/mod.rs) and the unified diff (src/udiff.rs).

/** `DiffableStr::tokenize_lines` for `str`: each line keeps its `\n`, `\r` or `\r\n`. */
export function tokenizeLines(s: string): string[] {
  const lines: string[] = [];
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x0d) {
      let end = i + 1;
      if (c === 0x0d && s.charCodeAt(i + 1) === 0x0a) {
        end = i + 2;
        i++;
      }
      lines.push(s.slice(last, end));
      last = end;
    }
  }
  if (last < s.length) lines.push(s.slice(last));
  return lines;
}

/** `TextDiffConfig::capture_ops` for `Algorithm::Myers` without a deadline. */
function captureOps(old: Seq, oldLen: number, new_: Seq, newLen: number): DiffOp[] {
  const capture = new Capture();
  const d = new Compact(new Replace(capture), old, new_);
  if (oldLen > 100 || newLen > 100) {
    // `capture_ops_pretrimmed`.
    const prefix = commonPrefixLen(old, 0, oldLen, new_, 0, newLen);
    const suffix = commonSuffixLen(old, prefix, oldLen, new_, prefix, newLen);
    const oldMid: Range = { start: prefix, end: oldLen - suffix };
    const newMid: Range = { start: prefix, end: newLen - suffix };
    if (prefix > 0) d.equal(0, 0, prefix);
    const oldMidEmpty = oldMid.start >= oldMid.end;
    const newMidEmpty = newMid.start >= newMid.end;
    if (!oldMidEmpty && !newMidEmpty) {
      myersDiff(new NoFinish(d), old, oldMid.start, oldMid.end, new_, newMid.start, newMid.end);
    } else if (!oldMidEmpty) {
      d.delete(oldMid.start, oldMid.end - oldMid.start, newMid.start);
    } else if (!newMidEmpty) {
      d.insert(oldMid.start, newMid.start, newMid.end - newMid.start);
    }
    if (suffix > 0) d.equal(oldLen - suffix, newLen - suffix, suffix);
    d.finish();
  } else {
    // `capture_diff_deadline`.
    myersDiff(d, old, 0, oldLen, new_, 0, newLen);
  }
  return capture.ops;
}

/** `TextDiff::from_lines(old, new).ops()`, with the tokenized lines. */
export function diffLines(
  old: string,
  new_: string,
): { oldLines: string[]; newLines: string[]; ops: DiffOp[] } {
  const oldLines = tokenizeLines(old);
  const newLines = tokenizeLines(new_);
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const oldIds = Int32Array.from(oldLines, intern);
  const newIds = Int32Array.from(newLines, intern);
  const ops = captureOps(oldIds, oldIds.length, newIds, newIds.length);
  return { oldLines, newLines, ops };
}

/** `group_diff_ops`. */
export function groupDiffOps(input: DiffOp[], n: number): DiffOp[][] {
  if (input.length === 0) return [];
  const ops = input.map((op) => ({ ...op }));
  const first = ops[0]!;
  if (first.tag === "equal") {
    const offset = Math.max(first.oldLen - n, 0);
    first.oldIndex += offset;
    first.newIndex += offset;
    first.oldLen -= offset;
    first.newLen = first.oldLen;
  }
  const last = ops[ops.length - 1]!;
  if (last.tag === "equal") {
    last.oldLen -= Math.max(last.oldLen - n, 0);
    last.newLen = last.oldLen;
  }
  const rv: DiffOp[][] = [];
  let pending: DiffOp[] = [];
  for (const op of ops) {
    if (op.tag === "equal" && op.oldLen > n * 2) {
      pending.push(equalOp(op.oldIndex, op.newIndex, n));
      rv.push(pending);
      const offset = Math.max(op.oldLen - n, 0);
      pending = [equalOp(op.oldIndex + offset, op.newIndex + offset, op.oldLen - offset)];
      continue;
    }
    pending.push(op);
  }
  if (!(pending.length === 0 || (pending.length === 1 && pending[0]!.tag === "equal"))) {
    rv.push(pending);
  }
  return rv;
}

/** `UnifiedDiffHunkRange`'s Display. */
function hunkRange(start: number, end: number): string {
  let beginning = start + 1;
  const len = Math.max(end - start, 0);
  if (len === 1) return `${beginning}`;
  if (len === 0) beginning -= 1;
  return `${beginning},${len}`;
}

function endsWithNewline(s: string): boolean {
  return s.endsWith("\n") || s.endsWith("\r");
}

/**
 * `TextDiff::from_lines(old, new).unified_diff().context_radius(3).header(a, b).to_string()`:
 * empty when the texts have no differing line, otherwise `--- a`, `+++ b` and the hunks.
 */
export function unifiedDiff(old: string, new_: string, a: string, b: string): string {
  const { oldLines, newLines, ops } = diffLines(old, new_);
  let out = "";
  let header = true;
  for (const hunk of groupDiffOps(ops, 3)) {
    if (hunk.length === 0) continue;
    if (header) {
      out += `--- ${a}\n+++ ${b}\n`;
      header = false;
    }
    const first = hunk[0]!;
    const last = hunk[hunk.length - 1]!;
    let emitted = false;
    const emit = (tag: string, value: string) => {
      if (!emitted) {
        out += `@@ -${hunkRange(first.oldIndex, oldEnd(last))} +${hunkRange(first.newIndex, newEnd(last))} @@\n`;
        emitted = true;
      }
      out += tag + value;
      if (!endsWithNewline(value)) out += "\n\\ No newline at end of file\n";
    };
    for (const op of hunk) {
      if (op.tag === "equal") {
        for (let i = 0; i < op.oldLen; i++) emit(" ", oldLines[op.oldIndex + i]!);
      }
      if (op.tag === "delete" || op.tag === "replace") {
        for (let i = 0; i < op.oldLen; i++) emit("-", oldLines[op.oldIndex + i]!);
      }
      if (op.tag === "insert" || op.tag === "replace") {
        for (let i = 0; i < op.newLen; i++) emit("+", newLines[op.newIndex + i]!);
      }
    }
  }
  return out;
}
