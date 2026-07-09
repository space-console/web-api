// Space Console stats store — a tiny SQLite layer for the metrics the console
// wants to keep across devices: which games get played, high scores, and 2-player
// results. It lives here (server-side) rather than in each browser because the
// numbers are aggregate — a leaderboard spans every phone that ever played.
//
// SQLite is a single file (DB_PATH, default ./data/spaceconsole.db): zero-config
// locally, trivially portable to the deploy box, and the schema maps cleanly to
// Postgres later if we outgrow it. All writes are fire-and-forget from the app's
// point of view; this module just needs to be fast and never throw into the relay.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "spaceconsole.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // concurrent reads while a write is in flight

db.exec(`
  -- One row per game launch. Answers "which games are played more" and, via
  -- player_count, how often the console is used solo vs. with friends.
  CREATE TABLE IF NOT EXISTS plays (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id      TEXT    NOT NULL,
    room_code    TEXT,
    player_count INTEGER NOT NULL DEFAULT 1,
    started_at   INTEGER NOT NULL           -- epoch ms
  );
  CREATE INDEX IF NOT EXISTS idx_plays_game ON plays(game_id);

  -- One row per finished game that produced a score (tetris, snake, …). The
  -- leaderboard is just the top N of these per game_id.
  CREATE TABLE IF NOT EXISTS scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     TEXT    NOT NULL,
    player_name TEXT    NOT NULL DEFAULT 'Guest',
    score       INTEGER NOT NULL,
    room_code   TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scores_game_score ON scores(game_id, score DESC);

  -- One row per finished 2-player game (tic-tac-toe, …): who won, or a draw.
  -- players holds the seat roster as JSON [{slot,name}] for head-to-head records.
  CREATE TABLE IF NOT EXISTS results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     TEXT    NOT NULL,
    room_code   TEXT,
    outcome     TEXT    NOT NULL,           -- 'win' | 'draw'
    winner_name TEXT,                       -- null on a draw
    winner_slot INTEGER,                    -- 1-based seat; null on a draw
    players     TEXT,                       -- JSON: [{ slot, name }]
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_results_game ON results(game_id);
`);

// ---- Prepared statements (compiled once, reused) --------------------------
const stmt = {
  insertPlay: db.prepare(
    `INSERT INTO plays (game_id, room_code, player_count, started_at)
     VALUES (@gameId, @roomCode, @playerCount, @startedAt)`
  ),
  insertScore: db.prepare(
    `INSERT INTO scores (game_id, player_name, score, room_code, created_at)
     VALUES (@gameId, @playerName, @score, @roomCode, @createdAt)`
  ),
  insertResult: db.prepare(
    `INSERT INTO results (game_id, room_code, outcome, winner_name, winner_slot, players, created_at)
     VALUES (@gameId, @roomCode, @outcome, @winnerName, @winnerSlot, @players, @createdAt)`
  ),
  topScores: db.prepare(
    `SELECT player_name AS name, score, created_at AS at
       FROM scores WHERE game_id = ? ORDER BY score DESC, created_at ASC LIMIT ?`
  ),
  popular: db.prepare(
    `SELECT game_id AS game, COUNT(*) AS plays,
            MAX(player_count) AS maxPlayers, SUM(player_count > 1) AS multiplayerPlays
       FROM plays GROUP BY game_id ORDER BY plays DESC LIMIT ?`
  ),
  totalPlays: db.prepare(`SELECT COUNT(*) AS n FROM plays`),
};

// ---- Public API -----------------------------------------------------------

/** Log that a game was launched (popularity + solo-vs-multiplayer signal). */
export function recordPlay({ gameId, roomCode = null, playerCount = 1 }) {
  stmt.insertPlay.run({
    gameId, roomCode,
    playerCount: clampInt(playerCount, 1, 8),
    startedAt: Date.now(),
  });
}

/** Record a final score for a leaderboard game. */
export function recordScore({ gameId, playerName = "Guest", score, roomCode = null }) {
  stmt.insertScore.run({
    gameId,
    playerName: String(playerName).slice(0, 24) || "Guest",
    score: clampInt(score, -1e12, 1e12),
    roomCode,
    createdAt: Date.now(),
  });
}

/** Record the outcome of a finished 2-player game. */
export function recordResult({ gameId, roomCode = null, outcome, winnerName = null, winnerSlot = null, players = [] }) {
  stmt.insertResult.run({
    gameId, roomCode,
    outcome: outcome === "draw" ? "draw" : "win",
    winnerName: winnerName ? String(winnerName).slice(0, 24) : null,
    winnerSlot: winnerSlot != null ? clampInt(winnerSlot, 1, 8) : null,
    players: JSON.stringify(Array.isArray(players) ? players : []),
    createdAt: Date.now(),
  });
}

/** Top scores for one game. */
export function leaderboard(gameId, limit = 10) {
  return stmt.topScores.all(gameId, clampInt(limit, 1, 100));
}

/** Aggregate stats: most-played games + totals. */
export function stats(limit = 30) {
  return {
    totalPlays: stmt.totalPlays.get().n,
    popular: stmt.popular.all(clampInt(limit, 1, 100)),
  };
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}

export default db;
