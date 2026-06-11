"use strict";

/* ============================================================
 * XI [sai] clone — dice puzzle
 *
 * ルール:
 *  - サイコロの上に乗って歩くと、その方向にサイコロが転がる
 *  - 地上からサイコロを押すと転がる(後ろが塞がっていれば登る)
 *  - 上面が同じ目のサイコロが「目の数」以上隣接すると沈んで消える
 *    (1 は単独で消える)
 *  - 沈んでいる間に同じ目を隣接させると連鎖し、消滅が延長される
 *  - 盤面が埋まるとゲームオーバー
 * ============================================================ */

const COLS = 8;
const ROWS = 8;
const ROLL_MS = 150;
const SINK_MS = 4500;  // 完全に沈み切るまでの時間
const RISE_MS = 260;
const GHOST_MS = 1600;
const MOVE_COOLDOWN = 130;
const INITIAL_DICE = 8;
const MIN_DICE = 4;

const boardEl = document.getElementById("board");
const viewportEl = document.getElementById("viewport");
const popupsEl = document.getElementById("popups");
const scoreEl = document.getElementById("score");
const bestEl = document.getElementById("best");
const chainEl = document.getElementById("chain");
const messageEl = document.getElementById("message");
const messageTitle = document.getElementById("message-title");
const messageBody = document.getElementById("message-body");
const startBtn = document.getElementById("start-btn");

let CELL = 56;

const DIRS = {
  up:    { dx: 0,  dy: -1 },
  down:  { dx: 0,  dy: 1 },
  left:  { dx: -1, dy: 0 },
  right: { dx: 1,  dy: 0 },
};

/* ---------- die orientation ----------
 * 状態は (top, north, east) の3面で表す。反対面は 7 - 面。
 * 右手系の標準ダイス (top=1, north=2, east=3) から転がして
 * 24 通りの正しい向きを列挙する。 */
function rollState(s, dir) {
  const { top, north, east } = s;
  switch (dir) {
    case "up":    return { top: 7 - north, north: top, east };
    case "down":  return { top: north, north: 7 - top, east };
    case "right": return { top: 7 - east, north, east: top };
    case "left":  return { top: east, north, east: 7 - top };
  }
}

const ORIENTATIONS = (() => {
  const seen = new Map();
  const queue = [{ top: 1, north: 2, east: 3 }];
  while (queue.length) {
    const s = queue.pop();
    const key = s.top + "," + s.north;
    if (seen.has(key)) continue;
    seen.set(key, s);
    for (const d of Object.keys(DIRS)) queue.push(rollState(s, d));
  }
  return [...seen.values()];
})();

function randomOrientation(avoidTopOne) {
  let s;
  do {
    s = ORIENTATIONS[(Math.random() * ORIENTATIONS.length) | 0];
  } while (avoidTopOne && s.top === 1);
  return { ...s };
}

/* ---------- pip rendering ---------- */
const PIP_LAYOUT = {
  1: [[50, 50]],
  2: [[27, 27], [73, 73]],
  3: [[27, 27], [50, 50], [73, 73]],
  4: [[27, 27], [73, 27], [27, 73], [73, 73]],
  5: [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]],
  6: [[27, 27], [73, 27], [27, 50], [73, 50], [27, 73], [73, 73]],
};

function faceHTML(value) {
  return PIP_LAYOUT[value]
    .map(([x, y]) =>
      `<span class="pip${value === 1 ? " red" : ""}" style="left:${x}%;top:${y}%"></span>`)
    .join("");
}

/* ---------- game state ---------- */
let dice = [];
let grid = new Array(COLS * ROWS).fill(null);
let ghosts = [];
let player = { x: 0, y: 0, riding: false, el: null };
let score = 0;
let best = Number(localStorage.getItem("xi-clone-best") || 0);
let running = false;
let startTime = 0;
let nextSpawnAt = 0;
let rollLockUntil = 0;
let nextMoveAt = 0;
let dieSeq = 0;
const heldDirs = [];

const idx = (x, y) => y * COLS + x;
const inBounds = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;
const gridAt = (x, y) => grid[idx(x, y)];

// 黄色い点滅枠のマスは"出現予約"扱いで、サイコロは進入できない
const ghostAt = (x, y) => ghosts.some(g => g.x === x && g.y === y);

function neighborsOf(d) {
  const out = [];
  for (const { dx, dy } of Object.values(DIRS)) {
    const x = d.x + dx, y = d.y + dy;
    if (inBounds(x, y) && gridAt(x, y)) out.push(gridAt(x, y));
  }
  return out;
}

/* ---------- DOM helpers ---------- */
function createDieEl() {
  const die = document.createElement("div");
  die.className = "die";
  const roller = document.createElement("div");
  roller.className = "roller";
  const cube = document.createElement("div");
  cube.className = "cube";
  for (const f of ["bottom", "north", "south", "east", "west", "top"]) {
    const face = document.createElement("div");
    face.className = "face f-" + f;
    cube.appendChild(face);
  }
  roller.appendChild(cube);
  die.appendChild(roller);
  boardEl.appendChild(die);
  return die;
}

function setFaces(d) {
  const faces = {
    top: d.top, bottom: 7 - d.top,
    north: d.north, south: 7 - d.north,
    east: d.east, west: 7 - d.east,
  };
  for (const [name, value] of Object.entries(faces)) {
    d.el.querySelector(".face.f-" + name).innerHTML = faceHTML(value);
  }
}

function placeDieEl(d, z = 0) {
  d.el.style.transform =
    `translate3d(${d.x * CELL}px, ${d.y * CELL}px, ${z}px)`;
}

function updatePlayerEl() {
  const z = player.riding ? CELL : 0;
  player.el.style.transform =
    `translate3d(${player.x * CELL}px, ${player.y * CELL}px, ${z}px)`;
}

function addPopup(text, clientX, clientY, isChain) {
  const vp = viewportEl.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "popup" + (isChain ? " chain" : "");
  el.textContent = text;
  el.style.left = (clientX - vp.left) + "px";
  el.style.top = (clientY - vp.top) + "px";
  popupsEl.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function popupAtDie(d, text, isChain) {
  const r = d.el.getBoundingClientRect();
  addPopup(text, r.left + r.width / 2, r.top + r.height / 2, isChain);
}

/* ---------- dice lifecycle ---------- */
function addDie(x, y, orientation) {
  const d = {
    id: dieSeq++,
    x, y,
    ...orientation,
    state: "rising",
    riseStart: performance.now(),
    el: createDieEl(),
  };
  setFaces(d);
  placeDieEl(d, -CELL);
  dice.push(d);
  grid[idx(x, y)] = d;
  return d;
}

function removeDie(d) {
  d.el.remove();
  if (gridAt(d.x, d.y) === d) grid[idx(d.x, d.y)] = null;
  dice = dice.filter(v => v !== d);
  if (player.riding && player.x === d.x && player.y === d.y) {
    player.riding = false;
    updatePlayerEl();
  }
}

const ROLL_TRANSFORM = {
  up:    { origin: "50% 0%",   rotate: p => `rotateX(${90 * p}deg)` },
  down:  { origin: "50% 100%", rotate: p => `rotateX(${-90 * p}deg)` },
  right: { origin: "100% 50%", rotate: p => `rotateY(${90 * p}deg)` },
  left:  { origin: "0% 50%",   rotate: p => `rotateY(${-90 * p}deg)` },
};

function startRoll(d, dir, withPlayer) {
  const { dx, dy } = DIRS[dir];
  d.state = "rolling";
  d.roll = { dir, fromX: d.x, fromY: d.y, t0: performance.now() };
  grid[idx(d.x, d.y)] = null;
  d.x += dx;
  d.y += dy;
  grid[idx(d.x, d.y)] = d;
  d.el.querySelector(".roller").style.transformOrigin =
    ROLL_TRANSFORM[dir].origin;
  rollLockUntil = d.roll.t0 + ROLL_MS;
  if (withPlayer) {
    player.x = d.x;
    player.y = d.y;
    player.riding = true;
    updatePlayerEl();
  }
}

// 地上からの押し出し: 回転せず出目を保ったまま横に滑る
function startSlide(d, dir) {
  const { dx, dy } = DIRS[dir];
  d.state = "sliding";
  d.slide = { fromX: d.x, fromY: d.y, t0: performance.now() };
  grid[idx(d.x, d.y)] = null;
  d.x += dx;
  d.y += dy;
  grid[idx(d.x, d.y)] = d;
  rollLockUntil = d.slide.t0 + ROLL_MS;
}

function commitSlide(d) {
  d.state = "idle";
  d.slide = null;
  placeDieEl(d);
  resolveMatches(d);
}

function commitRoll(d) {
  const s = rollState(d, d.roll.dir);
  d.top = s.top; d.north = s.north; d.east = s.east;
  d.state = "idle";
  d.roll = null;
  d.el.querySelector(".roller").style.transform = "";
  setFaces(d);
  placeDieEl(d);
  resolveMatches(d);
}

/* ---------- match / sink / chain ---------- */
function collectCluster(d) {
  const cluster = [];
  const visited = new Set([d.id]);
  const queue = [d];
  while (queue.length) {
    const cur = queue.pop();
    cluster.push(cur);
    for (const nb of neighborsOf(cur)) {
      if (nb.state === "idle" && nb.top === d.top && !visited.has(nb.id)) {
        visited.add(nb.id);
        queue.push(nb);
      }
    }
  }
  return cluster;
}

function resolveMatches(d) {
  if (d.state !== "idle") return;
  const f = d.top;
  const cluster = collectCluster(d);

  if (f === 1) {
    // 1 は単独では消えない。沈下中のサイコロ(目を問わず)に
    // 隣接させたときだけ、盤上の 1 がすべて道連れで消える
    let group = null;
    for (const c of cluster) {
      for (const nb of neighborsOf(c)) {
        if (nb.state === "sinking") group = nb.sink.group;
      }
    }
    if (group) vanishOnes(group, d);
    return;
  }

  // 沈下中の同じ目のグループに隣接していれば連鎖参加
  let joinGroup = null;
  for (const c of cluster) {
    for (const nb of neighborsOf(c)) {
      if (nb.state === "sinking" && nb.top === f) joinGroup = nb.sink.group;
    }
  }

  if (joinGroup) {
    joinGroup.chain++;
    reviveGroup(joinGroup);
    startSink(cluster, joinGroup);
    const pts = f * 100 * cluster.length * joinGroup.chain;
    addScore(pts);
    chainEl.textContent = "x" + joinGroup.chain;
    popupAtDie(d, `CHAIN x${joinGroup.chain} +${pts}`, true);
  } else if (cluster.length >= f) {
    const group = { face: f, chain: 1, dice: [] };
    startSink(cluster, group);
    const pts = f * cluster.length * 100;
    addScore(pts);
    popupAtDie(d, `${f} x ${cluster.length}! +${pts}`, false);
  }
}

function vanishOnes(group, origin) {
  const ones = dice.filter(v => v.state === "idle" && v.top === 1);
  if (ones.length === 0) return;
  group.chain++;
  reviveGroup(group);
  startSink(ones, group);
  const pts = 100 * ones.length * group.chain;
  addScore(pts);
  chainEl.textContent = "x" + group.chain;
  popupAtDie(origin, `1 ALL! +${pts}`, true);
}

function startSink(cluster, group) {
  for (const d of cluster) {
    d.state = "sinking";
    d.sink = { depth: 0, mode: "sinking", group };
    d.el.classList.add("sinking");
    group.dice.push(d);
  }
}

// 連鎖参加時、沈みかけのグループを一旦せり上がらせて延命する
function reviveGroup(group) {
  for (const m of group.dice) {
    if (m.state === "sinking") m.sink.mode = "rising";
  }
}

function addScore(pts) {
  score += pts;
  scoreEl.textContent = score;
  if (score > best) {
    best = score;
    bestEl.textContent = best;
    localStorage.setItem("xi-clone-best", String(best));
  }
}

/* ---------- spawning ---------- */
function emptyCells(excludePlayer) {
  const ghostCells = new Set(ghosts.map(g => idx(g.x, g.y)));
  const out = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (gridAt(x, y)) continue;
      if (ghostCells.has(idx(x, y))) continue;
      if (excludePlayer && player.x === x && player.y === y) continue;
      out.push({ x, y });
    }
  }
  return out;
}

function trySpawn(now) {
  const cells = emptyCells(true);
  if (cells.length === 0) {
    if (emptyCells(false).length === 0 && ghosts.length === 0) gameOver();
    return;
  }
  const { x, y } = cells[(Math.random() * cells.length) | 0];
  const el = document.createElement("div");
  el.className = "ghost";
  // transform は点滅アニメーションに上書きされるため left/top で配置する
  el.style.left = x * CELL + "px";
  el.style.top = y * CELL + "px";
  boardEl.appendChild(el);
  ghosts.push({ x, y, t0: now, el });
}

function materialize(g) {
  g.el.remove();
  if (gridAt(g.x, g.y)) {
    // サイコロで塞がっていたら別の空きマスへ移す
    const cells = emptyCells(true);
    if (cells.length === 0) {
      if (emptyCells(false).length === 0) gameOver();
      return;
    }
    const c = cells[(Math.random() * cells.length) | 0];
    g.x = c.x; g.y = c.y;
  }
  addDie(g.x, g.y, randomOrientation(false));
  // 枠の上に立っていたプレイヤーは湧くサイコロに持ち上げられる
  if (!player.riding && player.x === g.x && player.y === g.y) {
    player.riding = true;
  }
}

// 開始直後はゆっくり、プレイ時間に応じて徐々に速くなる
function spawnInterval(now) {
  const elapsedSec = (now - startTime) / 1000;
  return Math.max(1500, 5500 - elapsedSec * 20);
}

/* ---------- player movement ---------- */
// 半分以上沈んだサイコロには乗り移れない
function canStandOn(d) {
  if (!d) return false;
  if (d.state === "idle") return true;
  return d.state === "sinking" && d.sink.depth < CELL / 2;
}

function tryMove(dir) {
  const { dx, dy } = DIRS[dir];
  const tx = player.x + dx, ty = player.y + dy;
  if (!inBounds(tx, ty)) return false;
  const here = gridAt(player.x, player.y);
  const target = gridAt(tx, ty);

  if (player.riding && here) {
    if (here.state === "idle") {
      if (!target) {
        if (ghostAt(tx, ty)) return false;  // 出現予約マスには転がせない
        startRoll(here, dir, true);
        return true;
      }
      if (canStandOn(target)) {
        player.x = tx; player.y = ty;
        updatePlayerEl();
        return true;
      }
    } else if (here.state === "sinking") {
      if (!target) {
        // 半分沈むまでは地面に飛び降りられない(誤入力での落下防止)
        if (here.sink.depth >= CELL / 2) {
          player.x = tx; player.y = ty; player.riding = false;
          updatePlayerEl();
          return true;
        }
        return false;
      }
      // 自分の足場が半分以上沈むと隣へは乗り移れない
      if (here.sink.depth < CELL / 2 && canStandOn(target)) {
        player.x = tx; player.y = ty;
        updatePlayerEl();
        return true;
      }
    }
    return false;
  }

  // 地上: 押すと出目を保ったまま滑る。歩いて登ることはできない
  // (上に乗るには黄色い枠の上に立ち、湧くサイコロに持ち上げてもらう)
  if (!target) {
    player.x = tx; player.y = ty;
    updatePlayerEl();
    return true;
  }
  if (target.state === "idle") {
    const bx = tx + dx, by = ty + dy;
    if (inBounds(bx, by) && !gridAt(bx, by) && !ghostAt(bx, by)) {
      startSlide(target, dir);
      player.x = tx; player.y = ty;
      updatePlayerEl();
      return true;
    }
  }
  return false;
}

function processInput(now) {
  if (!running) return;
  if (now < rollLockUntil || now < nextMoveAt) return;
  if (heldDirs.length === 0) return;
  const dir = heldDirs[heldDirs.length - 1];
  if (tryMove(dir)) nextMoveAt = now + MOVE_COOLDOWN;
}

/* ---------- main loop ---------- */
let lastFrameAt = 0;

function frame(now) {
  const dt = Math.min(50, now - (lastFrameAt || now));
  lastFrameAt = now;
  if (running) {
    // 転がり
    for (const d of dice) {
      if (d.state !== "rolling") continue;
      const p = (now - d.roll.t0) / ROLL_MS;
      if (p >= 1) {
        commitRoll(d);
      } else {
        d.el.style.transform =
          `translate3d(${d.roll.fromX * CELL}px, ${d.roll.fromY * CELL}px, 0)`;
        d.el.querySelector(".roller").style.transform =
          ROLL_TRANSFORM[d.roll.dir].rotate(p);
      }
    }
    // 滑り(地上からの押し出し)
    for (const d of dice) {
      if (d.state !== "sliding") continue;
      const p = (now - d.slide.t0) / ROLL_MS;
      if (p >= 1) {
        commitSlide(d);
      } else {
        const x = (d.slide.fromX + (d.x - d.slide.fromX) * p) * CELL;
        const y = (d.slide.fromY + (d.y - d.slide.fromY) * p) * CELL;
        d.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    }
    // せり上がり
    for (const d of dice) {
      if (d.state !== "rising") continue;
      const p = (now - d.riseStart) / RISE_MS;
      const lifting =
        player.riding && player.x === d.x && player.y === d.y;
      if (p >= 1) {
        d.state = "idle";
        placeDieEl(d);
        if (lifting) updatePlayerEl();
        resolveMatches(d);
      } else {
        placeDieEl(d, -CELL * (1 - p));
        // 黄色い枠の上に立っていたプレイヤーを持ち上げる
        if (lifting) {
          player.el.style.transform =
            `translate3d(${player.x * CELL}px, ${player.y * CELL}px, ${CELL * p}px)`;
        }
      }
    }
    // 沈下: 一定速度で地面に潜っていく(連鎖時は一旦せり上がる)
    const dz = (dt / SINK_MS) * CELL;
    for (const d of [...dice]) {
      if (d.state !== "sinking") continue;
      const s = d.sink;
      if (s.mode === "rising") {
        s.depth -= dz * 3;
        if (s.depth <= 0) { s.depth = 0; s.mode = "sinking"; }
      } else {
        s.depth += dz;
      }
      if (s.depth >= CELL) {
        removeDie(d);
        chainEl.textContent = "-";
        continue;
      }
      placeDieEl(d, -s.depth);
      d.el.style.opacity =
        s.depth > CELL * 0.8 ? String(1 - (s.depth / CELL - 0.8) * 3) : "1";
      // 上に乗っているプレイヤーも一緒に沈む
      if (player.riding && player.x === d.x && player.y === d.y) {
        player.el.style.transform =
          `translate3d(${player.x * CELL}px, ${player.y * CELL}px, ${CELL - s.depth}px)`;
      }
    }
    // 湧き
    for (const g of [...ghosts]) {
      if (now - g.t0 >= GHOST_MS) {
        ghosts = ghosts.filter(v => v !== g);
        materialize(g);
      }
    }
    if (now >= nextSpawnAt) {
      trySpawn(now);
      nextSpawnAt = now + spawnInterval(now);
    }
    if (dice.length + ghosts.length < MIN_DICE) trySpawn(now);

    processInput(now);
  }
  requestAnimationFrame(frame);
}

/* ---------- setup / reset ---------- */
function clearBoard() {
  for (const d of dice) d.el.remove();
  for (const g of ghosts) g.el.remove();
  dice = [];
  ghosts = [];
  grid = new Array(COLS * ROWS).fill(null);
  popupsEl.innerHTML = "";
}

function startGame() {
  clearBoard();
  score = 0;
  scoreEl.textContent = "0";
  bestEl.textContent = String(best);
  chainEl.textContent = "-";

  if (!player.el) {
    player.el = document.createElement("div");
    player.el.id = "player";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    player.el.appendChild(avatar);
  }
  boardEl.appendChild(player.el);

  // 初期配置: 即マッチしない向きで散らす
  let placed = 0;
  while (placed < INITIAL_DICE) {
    const x = (Math.random() * COLS) | 0;
    const y = (Math.random() * ROWS) | 0;
    if (gridAt(x, y)) continue;
    const d = addDie(x, y, randomOrientation(false));
    d.state = "idle";
    placeDieEl(d);
    let guard = 0;
    while (wouldMatch(d) && guard++ < 30) {
      Object.assign(d, randomOrientation(false));
      setFaces(d);
    }
    placed++;
  }

  // プレイヤーは空きマスへ
  const cells = emptyCells(false);
  const c = cells[(Math.random() * cells.length) | 0];
  player.x = c.x; player.y = c.y; player.riding = false;
  updatePlayerEl();

  startTime = performance.now();
  nextSpawnAt = startTime + 5000;
  rollLockUntil = 0;
  nextMoveAt = 0;
  running = true;
  messageEl.classList.add("hidden");
}

function wouldMatch(d) {
  if (d.top === 1) return false;  // 1 は単独では消えないルール
  let count = 1;
  const visited = new Set([d.id]);
  const queue = [d];
  while (queue.length) {
    const cur = queue.pop();
    for (const nb of neighborsOf(cur)) {
      if (nb.top === d.top && !visited.has(nb.id)) {
        visited.add(nb.id);
        queue.push(nb);
        count++;
      }
    }
  }
  return count >= d.top;
}

function gameOver() {
  running = false;
  messageTitle.textContent = "GAME OVER";
  messageBody.innerHTML =
    `SCORE <strong style="color:var(--accent)">${score}</strong>` +
    `　／　BEST ${best}<br><span class="key">R</span> でもう一度`;
  startBtn.textContent = "RETRY";
  messageEl.classList.remove("hidden");
}

/* ---------- input bindings ---------- */
const KEY_DIR = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right",
  W: "up", S: "down", A: "left", D: "right",
};

document.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") {
    startGame();
    return;
  }
  const dir = KEY_DIR[e.key];
  if (!dir) return;
  e.preventDefault();
  if (!heldDirs.includes(dir)) heldDirs.push(dir);
});

document.addEventListener("keyup", (e) => {
  const dir = KEY_DIR[e.key];
  if (!dir) return;
  const i = heldDirs.indexOf(dir);
  if (i >= 0) heldDirs.splice(i, 1);
});

window.addEventListener("blur", () => { heldDirs.length = 0; });

for (const btn of document.querySelectorAll(".dpad-btn")) {
  const dir = btn.dataset.dir;
  const press = (e) => {
    e.preventDefault();
    if (!heldDirs.includes(dir)) heldDirs.push(dir);
  };
  const release = () => {
    const i = heldDirs.indexOf(dir);
    if (i >= 0) heldDirs.splice(i, 1);
  };
  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
}

startBtn.addEventListener("click", startGame);

function readCell() {
  CELL = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--cell"));
}

window.addEventListener("resize", () => {
  readCell();
  for (const d of dice) if (d.state === "idle") placeDieEl(d);
  for (const g of ghosts) {
    g.el.style.left = g.x * CELL + "px";
    g.el.style.top = g.y * CELL + "px";
  }
  if (player.el) updatePlayerEl();
});

readCell();
requestAnimationFrame(frame);
