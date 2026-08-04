// Assemble the whole console into ONE static tree for web-api to serve.
//
// Why one tree: iOS Safari only lets page JS reach the exact host:port the page
// loaded from, so the launcher, the controller, the games, the signaling socket
// and the stats API must all share a single origin. Locally that's the developer's
// workspace root (STATIC_DIR=..); in a deploy it's the folder this script builds.
//
// Each sibling repo already publishes its built output to its `gh-pages` branch
// (that's what GitHub Pages serves), so a shallow clone of that branch IS the
// build artifact — no per-repo toolchain needed here.
//
// The layout has to match what the launcher expects: `games.js` resolves games
// as `../games/<id>/` relative to the launcher, i.e. they must be siblings.
//
//   public/
//     index.html          -> redirect to the landing page
//     landing/            -> the marketing site (what the bare domain shows)
//     game-launcher-web/  -> the TV app
//     game-controller/    -> the phone pad
//     games/<id>/         -> the games
//
// Usage: node scripts/build-static.mjs [outDir]   (default ./public)

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const OUT = path.resolve(process.argv[2] || process.env.STATIC_BUILD_DIR || "public");
const ORG = process.env.REPO_ORG || "space-console";
const REPOS = ["landing", "game-launcher-web", "game-controller", "games"];

// What the bare domain opens. The landing page explains the product to a
// first-time visitor and its primary CTA points straight at
// `/game-launcher-web/`, so anyone who already knows what this is stays one
// click from the menu — and everyone else gets an answer instead of a game grid
// with no context.
const ROOT = "landing";

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const repo of REPOS) {
  const dest = path.join(OUT, repo);
  const url = `https://github.com/${ORG}/${repo}.git`;
  console.log(`[build] cloning ${repo}#gh-pages`);
  // --depth 1: we want the published files, not the history.
  execFileSync("git", ["clone", "--depth", "1", "--branch", "gh-pages", url, dest], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  // Drop the git metadata and the PR preview folders — neither belongs in a deploy.
  fs.rmSync(path.join(dest, ".git"), { recursive: true, force: true });
  fs.rmSync(path.join(dest, "preview"), { recursive: true, force: true });

  // A repo whose gh-pages has only ever had a preview deployed (i.e. nothing has
  // landed on main yet) clones fine and then leaves an EMPTY folder once the
  // preview is dropped — the deploy would silently serve a 404 at that path. Fail
  // here instead, where the message can say which repo and why.
  if (!fs.existsSync(path.join(dest, "index.html"))) {
    throw new Error(
      `[build] ${repo}#gh-pages has no index.html at its root — nothing has been ` +
      `deployed to that repo's Pages root yet. Merge its first PR to main and let ` +
      `its Pages run finish, then rebuild.`
    );
  }
}

// Root redirect, so the bare domain lands on the landing page. Kept as a meta
// refresh (plus an immediate JS replace) so it works without any server-side
// routing. The query string is carried over so a link with `?signal=` / `?turn=`
// overrides still reaches a client that reads them.
fs.writeFileSync(path.join(OUT, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Space Console</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=./${ROOT}/">
<link rel="canonical" href="./${ROOT}/">
<script>location.replace("./${ROOT}/" + location.search);</script>
</head>
<body>Opening Space Console… <a href="./${ROOT}/">continue</a>.</body>
</html>
`);

console.log(`[build] static tree ready at ${OUT}`);
