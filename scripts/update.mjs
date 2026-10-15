#!/usr/bin/env node
/**
 * WARDOGS leaderboard updater for GitHub Actions.
 *
 * Runs once per call (GitHub runs it every ~20 minutes):
 *   1. Reads /v1/status and /v1/players from the WARDOGS RCON server.
 *   2. Tracks the current match in docs/data/state.json.
 *   3. When a new match has started (map change, server restart, match clock
 *      reset, or the scoreboard reset), the previous match is added ONCE to
 *      every player's saved totals: 20 kills in one match + 10 in the next = 30.
 *   4. Writes the files the web page reads:
 *        docs/data/stats.json       leaderboard + current match + server status
 *        docs/data/matches.json     list of finished matches
 *        docs/data/matches/<id>.json  per-player stats of one match
 *
 * No npm packages needed (Node 18+ has fetch built in).
 *
 * Settings (environment variables; in GitHub put them under
 * Settings > Secrets and variables > Actions):
 *   WARDOGS_PASSWORD   RCON password                 (secret, required)
 *   WARDOGS_HOST       RCON host                     (default 165.217.136.30)
 *   WARDOGS_PORT       RCON port                     (default 9001)
 *   WARDOGS_TITLE      server name shown on the page
 *
 * Local test:  WARDOGS_PASSWORD=... node scripts/update.mjs
 * Count the current match right now:  node scripts/update.mjs --finalize
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "docs", "data");
const MATCH_DIR = join(DATA_DIR, "matches");

const HOST = process.env.WARDOGS_HOST || "165.217.136.30";
const PORT = process.env.WARDOGS_PORT || "9001";
const PASSWORD = process.env.WARDOGS_PASSWORD || "";
const TITLE = process.env.WARDOGS_TITLE || "Adria/Balkan [GGG] Official";

const UPDATE_EVERY_SECONDS = 20 * 60;   // shown on the page; the schedule itself is in the workflow
const TIMEOUT_MS = 15000;
const MATCH_RESET_SECONDS = 10;         // match clock going back this much = new match
const STAT_RESET_MIN_PLAYERS = 3;       // this many players' stats dropping = new match

const STAT_FIELDS = ["kills", "deaths", "cash"];

const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

// ---------------------------------------------------------------------------
// FILES
// ---------------------------------------------------------------------------

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is damaged (${e.message}); fix or restore it from git history`);
  }
}

async function writeJson(path, value, pretty = false) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, pretty ? 2 : 0) + "\n", "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// RCON
// ---------------------------------------------------------------------------

async function rconGet(path) {
  const url = `http://${HOST}:${PORT}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${PASSWORD}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`cannot reach the server (${e.cause?.code || e.name})`);
  }
  if (!res.ok) {
    const hint = res.status === 401 ? " (wrong WARDOGS_PASSWORD?)" : "";
    const err = new Error(`HTTP ${res.status} on ${path}${hint}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function readServer() {
  const caps = await rconGet("/v1/capabilities");
  const routes = new Set(caps.routes || []);
  const status = await rconGet("/v1/status");
  const players = (await rconGet("/v1/players")).players || [];
  let serverId = null;
  if (routes.has("GET /v1/server-id")) {
    try {
      serverId = (await rconGet("/v1/server-id")).serverId || null;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return { status, players, serverId };
}

// ---------------------------------------------------------------------------
// MATCH TRACKING
// ---------------------------------------------------------------------------

const playerKey = (p) =>
  String(p.steamId || "").trim() || "NAME:" + String(p.name || "").trim().toLowerCase();

const clanFromName = (name) => {
  const m = /^\s*\[([^\]]+)\]/.exec(String(name || ""));
  return m ? m[1].trim() : "";
};

function cleanPlayer(p) {
  const out = {
    name: String(p.name || ""),
    steamId: String(p.steamId || ""),
    faction: String(p.faction || ""),
    pingMs: num(p.pingMs),
  };
  for (const f of STAT_FIELDS) out[f] = num(p[f]);
  return out;
}

/**
 * Combine a new scoreboard reading with what we have for this player in the
 * current match. Counters only go up during a match; if one player's counter
 * goes down while the match continues, they reconnected and the game
 * restarted it, so the old value is kept in "bank" and counting continues.
 */
function mergePlayer(old, fresh) {
  if (!old) return { ...fresh, bank: Object.fromEntries(STAT_FIELDS.map((f) => [f, 0])) };
  const merged = { ...old, bank: { ...(old.bank || {}) } };
  for (const f of ["name", "steamId", "faction"]) if (fresh[f]) merged[f] = fresh[f];
  merged.pingMs = fresh.pingMs;
  const reconnected = fresh.kills + fresh.deaths < num(old.kills) + num(old.deaths);
  for (const f of STAT_FIELDS) {
    if (reconnected && fresh[f] < num(old[f])) {
      merged.bank[f] = num(merged.bank[f]) + num(old[f]);
      merged[f] = fresh[f];
    } else {
      merged[f] = Math.max(num(old[f]), fresh[f]);
    }
  }
  return merged;
}

function matchTotals(p) {
  const bank = p.bank || {};
  return Object.fromEntries(STAT_FIELDS.map((f) => [f, num(p[f]) + num(bank[f])]));
}

const factionScoreTotal = (status) =>
  (status.factionScores || []).reduce((sum, f) => sum + num(f.score), 0);

function isNewMatch(live, serverId, status, players) {
  if (!live) return [true, "first observation"];
  if (serverId && live.serverId && serverId !== live.serverId) return [true, "server restarted"];

  const oldMap = String(live.map || ""), newMap = String(status.map || "");
  if (oldMap && newMap && oldMap !== newMap) return [true, `map changed ${oldMap} -> ${newMap}`];

  const oldS = live.lastMatchSeconds, newS = status.matchSeconds;
  if (oldS != null && newS != null && Number(newS) + MATCH_RESET_SECONDS < Number(oldS)) {
    return [true, `match clock reset ${oldS}s -> ${newS}s`];
  }

  const oldScore = live.lastFactionScoreTotal, newScore = factionScoreTotal(status);
  if (oldScore && newScore < oldScore) return [true, `faction score reset ${oldScore} -> ${newScore}`];

  let overlap = 0, dropped = 0;
  for (const p of players) {
    const old = (live.players || {})[playerKey(p)];
    if (!old) continue;
    overlap++;
    if (num(p.kills) + num(p.deaths) < num(old.kills) + num(old.deaths)) dropped++;
  }
  if (overlap >= STAT_RESET_MIN_PLAYERS &&
      dropped >= Math.max(STAT_RESET_MIN_PLAYERS, Math.floor(overlap / 2))) {
    return [true, `scoreboard reset (${dropped}/${overlap} players dropped)`];
  }
  return [false, "same match"];
}

function updateLive(live, serverId, status, players) {
  const now = utcNow();
  if (!live) {
    live = { uuid: randomUUID(), serverId: serverId || "", map: status.map || "",
             startedUtc: now, players: {} };
  }
  live.serverId = serverId || live.serverId || "";
  live.map = status.map || live.map || "";
  live.lastSeenUtc = now;
  live.lastMatchSeconds = status.matchSeconds ?? null;
  live.lastFactionScoreTotal = factionScoreTotal(status);
  live.online = [];
  for (const p of players) {
    const key = playerKey(p);
    live.players[key] = mergePlayer(live.players[key], cleanPlayer(p));
    live.online.push(key);
  }
  return live;
}

/** Add a finished match to the totals. Returns the match id, or null if skipped. */
async function commitMatch(state, totals, matches, reason) {
  const live = state.live;
  const entries = Object.entries(live?.players || {});
  if (!entries.length) return null;

  const activity = entries.reduce((s, [, p]) => {
    const t = matchTotals(p);
    return s + t.kills + t.deaths;
  }, 0);
  if (activity === 0) {
    console.log(`skipped ${live.map} (${reason}): nobody had kills or deaths`);
    return null;
  }
  if (matches.some((m) => m.uuid === live.uuid)) return null;   // already counted

  const id = (matches.reduce((m, x) => Math.max(m, x.id), 0)) + 1;
  const started = live.startedUtc || utcNow();
  const ended = live.lastSeenUtc || utcNow();

  const rows = entries.map(([key, p]) => ({
    key, name: p.name || "", clan: clanFromName(p.name), faction: p.faction || "",
    ...matchTotals(p),
  })).sort((a, b) => b.kills - a.kills || b.cash - a.cash || a.name.localeCompare(b.name));

  for (const r of rows) {
    const t = totals[r.key] || (totals[r.key] = {
      name: "", clan: "", matchesSeen: 0, matchesScored: 0, kills: 0, deaths: 0, cash: 0,
    });
    if (r.name) { t.name = r.name; t.clan = clanFromName(r.name) || t.clan; }
    t.matchesSeen += 1;
    if (r.kills || r.deaths || r.cash) t.matchesScored += 1;
    t.kills += r.kills;
    t.deaths += r.deaths;
    t.cash += r.cash;
    t.lastSeenUtc = ended;
  }

  const label = `${live.map || "Unknown map"} - ${started.slice(0, 10)}`;
  matches.push({ id, uuid: live.uuid, label, map: live.map || "", source: "RCON",
                 startedUtc: started, endedUtc: ended, playersRecorded: rows.length,
                 hasDetail: true });
  await writeJson(join(MATCH_DIR, `${id}.json`), {
    id, label, map: live.map || "", source: "RCON", startedUtc: started, endedUtc: ended,
    players: rows,
  });
  console.log(`match #${id} counted (${reason}): ${live.map} with ${rows.length} players`);
  return id;
}

// ---------------------------------------------------------------------------
// OUTPUT FOR THE PAGE
// ---------------------------------------------------------------------------

function buildStats(state, totals, matches) {
  const players = Object.entries(totals)
    .map(([key, t]) => ({ key, ...t }))
    .sort((a, b) => b.kills - a.kills || b.cash - a.cash ||
                    a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((t, i) => ({
      rank: i + 1,
      key: t.key,
      name: t.name,
      clan: t.clan,
      matchesSeen: t.matchesSeen,
      matchesScored: t.matchesScored,
      kills: t.kills,
      deaths: t.deaths,
      cash: t.cash,
      kd: t.deaths ? Math.round((t.kills / t.deaths) * 100) / 100 : t.kills,
      killsPerMatch: t.matchesScored ? Math.round((t.kills / t.matchesScored) * 100) / 100 : null,
      cashPerMatch: t.matchesScored ? Math.round(t.cash / t.matchesScored) : null,
      lastSeenUtc: t.lastSeenUtc || null,
    }));

  let live = null;
  if (state.live) {
    const online = new Set(state.live.online || []);
    const lp = Object.entries(state.live.players || {}).map(([key, p]) => ({
      key, name: p.name || "", clan: clanFromName(p.name),
      faction: p.faction || "Unassigned", pingMs: p.pingMs || 0,
      online: online.has(key), ...matchTotals(p),
    })).sort((a, b) => b.kills - a.kills || b.cash - a.cash || a.name.localeCompare(b.name));
    const factions = {};
    for (const p of lp) {
      if (!p.online) continue;
      const f = factions[p.faction] ||= { name: p.faction, players: 0, kills: 0, deaths: 0, cash: 0 };
      f.players++; f.kills += p.kills; f.deaths += p.deaths; f.cash += p.cash;
    }
    live = {
      map: state.live.map, startedUtc: state.live.startedUtc, lastSeenUtc: state.live.lastSeenUtc,
      factions: Object.values(factions).sort((a, b) => b.kills - a.kills),
      players: lp,
    };
  }

  return {
    title: TITLE,
    generatedUtc: utcNow(),
    pollSeconds: UPDATE_EVERY_SECONDS,
    matchCount: matches.length,
    status: state.status || null,
    live,
    players,
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const finalizeOnly = process.argv.includes("--finalize");

  const statePath = join(DATA_DIR, "state.json");
  const totalsPath = join(DATA_DIR, "totals.json");
  const matchesPath = join(DATA_DIR, "matches.json");

  const state = await readJson(statePath, { live: null, status: null });
  const totals = await readJson(totalsPath, {});
  const matches = (await readJson(matchesPath, { matches: [] })).matches;

  let exitCode = 0;

  if (finalizeOnly) {
    const id = await commitMatch(state, totals, matches, "manual finalize");
    state.live = null;
    console.log(id ? `counted the current match as #${id}` : "nothing to count");
  } else {
    if (!PASSWORD) {
      console.error("WARDOGS_PASSWORD is not set (add it as a repository secret)");
      process.exit(1);
    }
    try {
      const { status, players, serverId } = await readServer();
      const [isNew, reason] = isNewMatch(state.live, serverId, status, players);
      if (state.live && isNew) {
        await commitMatch(state, totals, matches, reason);
        state.live = null;
      }
      state.live = updateLive(state.live, serverId, status, players);
      const counts = status.players || {};
      state.status = {
        online: true,
        map: status.map ?? null,
        playersCurrent: counts.current ?? players.length,
        playersMax: counts.max ?? null,
        matchSeconds: status.matchSeconds ?? null,
        polledUtc: utcNow(),
        error: null,
      };
      console.log(`read ${players.length} players on ${status.map || "?"}`);
    } catch (e) {
      console.error(`update failed: ${e.message}`);
      state.status = { ...(state.status || {}), online: false, error: e.message, failedUtc: utcNow() };
      // A wrong password should show up as a failed run so you notice it.
      if (e.status === 401) exitCode = 1;
    }
  }

  await writeJson(statePath, state);
  await writeJson(totalsPath, totals);
  // uuid stays in the file: it is how a match is never counted twice
  await writeJson(matchesPath, { matches: [...matches].sort((a, b) => b.id - a.id) });
  await writeJson(join(DATA_DIR, "stats.json"), buildStats(state, totals, matches));
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
