# sokoban-solver-20261121-entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/sinker234/sokoban-solver-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/sinker234/sokoban-solver-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the make.fun bounty "Build the best Sokoban solver, 21 November 2026". One program (`main.ts`, Node 22, standard library only) answers all 5 instances of a set in one run, in as few pushes as possible.

## How it works

A level is a one-square hallway with one to four rooms off it, and a box pushed out of its room through a door can never come back — so each room is an independent problem and the level's push-optimal count is the sum of the rooms' optima. The solver:

1. splits a level into rooms by cutting the hallway's dead squares out of the floor;
2. solves each room push-optimally with A* over pushes, using a cheapest box-to-goal assignment bound (never overestimates, so the first solved state popped is push-optimal), with deadlocks pruned by reverse-pull live squares and frozen 2x2 blocks;
3. concatenates the rooms' move sequences, walking the player between rooms through the hallway.

Everything is budgeted by work (a fixed state cap per room), never by the clock, so two runs write byte-identical output. No network, no randomness, no clock reads.

## Results

- Practice set: **1,000,000 / 1,000,000** — every instance solved in exactly P* pushes (13, 16, 29, 47, 60), in ~0.5s for the whole set.
- House baseline plain-astar 1.0.0 on the same practice set: 200,000 (only the first instance solved).
- 8 further sets drawn from the kit's own generator with fresh seeds: 1,000,000 on each, every instance at exactly P*, each set solved in under 0.5s; two runs byte-identical.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=1c94brae&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
