// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Strategy (written from the competition's own rules, not copied from the kit):
// a level is a hallway with 1-4 independent rooms off it, each holding 3-4 boxes,
// and a box that leaves its room can never come back, so the level's push-optimal
// count is the sum of the rooms' optima. The solver therefore
//   1. splits a level into rooms by cutting the hallway's dead squares out of the floor,
//   2. solves each room push-optimally with A* over pushes, falling back to
//      a push-by-push breadth-first search if the A* ever runs out of states,
//      and
//   3. concatenates the rooms' move sequences, walking the player between rooms.
//
// The per-room A* searches push states (sorted box squares + the player's reachable
// region, named by its lowest square). Its estimate is the cheapest assignment of
// boxes to goals by box-free grid distance, which never overestimates the pushes
// still needed, so the first solved state popped is push-optimal. Deadlocks are
// pruned with reverse-pull live squares (a box off every goal route is dead) and
// frozen 2x2 blocks of walls and boxes. Everything is budgeted by work (a fixed
// state cap per room), never by the clock, so two runs write identical bytes.
//
// Node 22, standard library only. Reads /input/<id>/level.txt, writes
// /output/<id>/solution.txt for each of i001..i005 in one run.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four steps: [dx, dy, walk letter, push letter]. Fixed order keeps every tie-break deterministic. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** The most states one room's search may create before it gives up: work, never the clock. */
const MAX_STATES = 500_000;
/**
 * The most states the breadth-first fallback may create. The generator keeps a
 * room only when its own breadth-first search solves it within 250,000 states,
 * so this cap sits above every room the generator can draw.
 */
const BFS_MAX_STATES = 400_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a lone box can be pushed from onto some goal: pull back from the
 * goals. A box is pulled from y to x when the player can stand at y - d, so a
 * square y joins when both y and y - d are open floor.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Grid distances from one start over open floor, ignoring boxes. */
function bfsDist(wall: Uint8Array, w: number, start: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [start];
  dist[start] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] === -1) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Cheapest assignment of boxes to goals by box-free grid distance, via DP over
 * goal subsets. Infinity when some box reaches no goal. Admissible: one push
 * moves one box one square, so the true remaining pushes are at least this.
 */
function assignmentBound(boxes: number[], goalDist: Int32Array[]): number {
  const n = boxes.length;
  const m = goalDist.length;
  if (n === 0) return 0;
  const cost: number[][] = boxes.map((b) => goalDist.map((gd) => gd[b]!));
  for (let i = 0; i < n; i++) {
    if (cost[i]!.every((c) => c < 0)) return Infinity;
  }
  const dp = new Float64Array(1 << m).fill(Infinity);
  dp[0] = 0;
  for (let mask = 0; mask < 1 << m; mask++) {
    const i = popcount(mask);
    if (i >= n || dp[mask] === Infinity) continue;
    for (let j = 0; j < m; j++) {
      if (mask & (1 << j)) continue;
      const c = cost[i]![j]!;
      if (c >= 0) dp[mask | (1 << j)] = Math.min(dp[mask | (1 << j)]!, dp[mask]! + c);
    }
  }
  let best = Infinity;
  for (let mask = 0; mask < 1 << m; mask++) {
    if (popcount(mask) === n) best = Math.min(best, dp[mask]!);
  }
  return best;
}

function popcount(x: number): number {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

/**
 * Push-optimal solution of one (sub-)level by A* over pushes, or null when the
 * search gives up. `level` carries the walls (other rooms' boxes included),
 * the room's own goals and boxes, and the player's square. When the A* runs
 * out of states it falls back to a push-by-push breadth-first search (the
 * search the generator itself keeps every room solvable by), so a room the
 * generator can draw still gets its push-optimal answer instead of nothing.
 */
function solveRoom(level: Level): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const goalDist = goals.map((g) => bfsDist(wall, w, g));
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  // State key: the region's lowest square, then the sorted box squares, digits in base `size`.
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const decodeBoxes = (key: number, n: number): number[] => {
    const boxes = new Array<number>(n);
    for (let i = n - 1; i >= 0; i--) {
      boxes[i] = key % size;
      key = Math.floor(key / size);
    }
    return boxes;
  };

  // Flood fill from the player over open floor around the boxes; returns the
  // region's lowest square and stamps every reachable square in `seenArr` with
  // the next stamp from `counter`. Two stamp arrays are kept: one for the state
  // being expanded (its region decides which pushes the player can reach) and
  // one for a child state's key (its region's lowest square names the child),
  // so computing a child's key never clobbers the parent's region.
  const seen = new Int32Array(size);
  const markSeen = new Int32Array(size);
  const stack = new Int32Array(size);
  const stamps = { seen: 0, mark: 0 };
  const reach = (seenArr: Int32Array, which: 'seen' | 'mark', occupied: Uint8Array, from: number): number => {
    stamps[which]++;
    const stamp = stamps[which];
    let low = from;
    let n = 0;
    stack[n++] = from;
    seenArr[from] = stamp;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (!wall[q] && !occupied[q] && seenArr[q] !== stamp) {
          seenArr[q] = stamp;
          stack[n++] = q;
        }
      }
    }
    return low;
  };

  /** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
  const frozenBlock = (occupied: Uint8Array, t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) || (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
    }
    return false;
  };

  const n = level.boxes.length;
  const occupied = new Uint8Array(size);
  for (const b of level.boxes) occupied[b] = 1;

  // Rebuild the moves for the state `foundIdx` of a search kept in the given
  // parent/push arrays: for each push, walk to the pushing square, then push.
  const buildMoves = (
    parentsArr: number[], pushFromArr: number[], pushDirArr: number[], foundIdx: number,
  ): { pushes: number; moves: string } => {
    const path: number[] = [];
    for (let s = foundIdx; s > 0; s = parentsArr[s]!) path.push(s);
    path.reverse();
    let moves = '';
    let player = level.player;
    let boxes = level.boxes;
    for (const s of path) {
      const from = pushFromArr[s]!;
      const k = pushDirArr[s]!;
      const [dx, dy, , pushLetter] = DIRS[k]!;
      const d = dy * w + dx;
      const to = from + d;
      for (const b of boxes) occupied[b] = 1;
      moves += walkTo(level, occupied, player, from - d);
      for (const b of boxes) occupied[b] = 0;
      moves += pushLetter;
      player = from;
      boxes = boxes.map((b) => (b === from ? to : b)).sort((a, b) => a - b);
    }
    return { pushes: path.length, moves };
  };

  /**
   * The same room solved by breadth-first search over pushes, expanding
   * states in order of pushes made, so the first solved state met is
   * push-optimal. Same state keys, same deadlock pruning, same fixed
   * direction order, so the answer is deterministic. Used only when the A*
   * above runs out of states.
   */
  const bfsFallback = (): { pushes: number; moves: string } | null => {
    bestG.clear();
    const bKeys: number[] = [];
    const bPlayers: number[] = [];
    const bParents: number[] = [];
    const bPushFrom: number[] = [];
    const bPushDir: number[] = [];
    const seenKeys = new Set<number>();
    const queue: number[] = [];
    for (const b of level.boxes) occupied[b] = 1;
    const low0 = reach(seen, 'seen', occupied, level.player);
    for (const b of level.boxes) occupied[b] = 0;
    const k0 = keyOf(level.boxes, low0);
    bKeys.push(k0);
    bPlayers.push(level.player);
    bParents.push(-1);
    bPushFrom.push(-1);
    bPushDir.push(-1);
    seenKeys.add(k0);
    queue.push(0);
    let head = 0;
    let foundB = solved(level.boxes) ? 0 : -1;
    while (head < queue.length && foundB < 0) {
      const s = queue[head++]!;
      const boxes = decodeBoxes(bKeys[s]!, n);
      for (const b of boxes) occupied[b] = 1;
      reach(seen, 'seen', occupied, bPlayers[s]!);
      const regionStamp = stamps.seen;
      for (let bi = 0; bi < n && foundB < 0; bi++) {
        const b = boxes[bi]!;
        for (let k = 0; k < 4; k++) {
          const [dx, dy] = DIRS[k]!;
          const d = dy * w + dx;
          const t = b + d;
          if (seen[b - d] !== regionStamp || wall[t] || occupied[t] || !live[t]) continue;
          occupied[b] = 0;
          occupied[t] = 1;
          const frozen = frozenBlock(occupied, t);
          let key = -1;
          let next: number[] | null = null;
          if (!frozen) {
            next = boxes.slice();
            next[bi] = t;
            next.sort((a, bb) => a - bb);
            if (next.every((x) => live[x])) key = keyOf(next, reach(markSeen, 'mark', occupied, b));
          }
          occupied[t] = 0;
          occupied[b] = 1;
          if (key < 0 || seenKeys.has(key)) continue;
          if (bKeys.length >= BFS_MAX_STATES) {
            for (const x of boxes) occupied[x] = 0;
            return null;
          }
          seenKeys.add(key);
          bKeys.push(key);
          bPlayers.push(b);
          bParents.push(s);
          bPushFrom.push(b);
          bPushDir.push(k);
          queue.push(bKeys.length - 1);
          if (solved(next!)) {
            foundB = bKeys.length - 1;
            break;
          }
        }
      }
      for (const x of boxes) occupied[x] = 0;
    }
    if (foundB < 0) return null;
    return buildMoves(bParents, bPushFrom, bPushDir, foundB);
  };

  // States, in creation order: key, parent, the square the pushed box left, the push direction, pushes so far, estimate.
  const keys: number[] = [];
  const players: number[] = [];
  const parents: number[] = [];
  const pushFrom: number[] = [];
  const pushDir: number[] = [];
  const gs: number[] = [];
  const hs: number[] = [];
  const bestG = new Map<number, number>();

  const h0 = assignmentBound(level.boxes, goalDist);
  if (h0 === Infinity) return null;
  const low0 = reach(seen, 'seen', occupied, level.player);
  keys.push(keyOf(level.boxes, low0));
  players.push(level.player);
  parents.push(-1);
  pushFrom.push(-1);
  pushDir.push(-1);
  gs.push(0);
  hs.push(h0);
  bestG.set(keys[0]!, 0);

  // Binary heap on (f, h, insertion order): [f, h, seq, state index].
  const heap: [number, number, number, number][] = [[h0, h0, 0, 0]];
  let seq = 1;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = solved(level.boxes) ? 0 : -1;
  let exhausted = false;
  while (heap.length > 0 && found < 0 && !exhausted) {
    const [, , , s] = heapPop();
    if (bestG.get(keys[s]!) !== gs[s]) continue; // a better route to this state was found
    const boxes = decodeBoxes(keys[s]!, n);
    for (const b of boxes) occupied[b] = 1;
    reach(seen, 'seen', occupied, players[s]!);
    const regionStamp = stamps.seen;
    for (let bi = 0; bi < n && found < 0 && !exhausted; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== regionStamp || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(occupied, t);
        let key = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, bb) => a - bb);
          if (next.every((x) => live[x])) {
            h = assignmentBound(next, goalDist);
            if (h !== Infinity) key = keyOf(next, reach(markSeen, 'mark', occupied, b));
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (key < 0 || bestG.has(key) && bestG.get(key)! <= gs[s]! + 1) continue;
        if (keys.length >= MAX_STATES) {
          exhausted = true;
          break;
        }
        bestG.set(key, gs[s]! + 1);
        keys.push(key);
        players.push(b);
        parents.push(s);
        pushFrom.push(b);
        pushDir.push(k);
        gs.push(gs[s]! + 1);
        hs.push(h);
        heapPush([gs[s]! + 1 + h, h, seq++, keys.length - 1]);
        if (solved(next!)) {
          found = keys.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) {
    // The A* ran out of states: the breadth-first fallback still returns the
    // push-optimal answer for any room the generator could draw. Only a room
    // no search can solve returns null.
    if (exhausted) return bfsFallback();
    return null;
  }
  return buildMoves(parents, pushFrom, pushDir, found);
}

/** Shortest walk from `from` to `to` around walls and boxes, lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor; each remaining part holding a box
 * is a room. Null when some part holds more or fewer boxes than goals, a box
 * starts in the hallway, or a goal lies outside every part.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level room by room; null when any room's search gives up. */
function solveLevel(text: string): string | null {
  const level = parseLevel(text);
  if (level.boxes.every((b, i) => level.goals.includes(b)) && level.boxes.length === level.goals.length) return '';
  const rooms = roomsOf(level);
  if (rooms === null) {
    // No room structure (or a tiny level): try the whole level as one room.
    if (level.boxes.length > 5) return null;
    const whole = solveRoom(level);
    return whole === null ? null : whole.moves;
  }
  let player = level.player;
  let moves = '';
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const other = rooms[oj]!;
      for (const b of done[oj] ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub);
    if (solved === null) return null;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done[ri] = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')) ?? '';
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
