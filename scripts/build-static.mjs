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
//     index.html          -> redirect to the launcher
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
const REPOS = ["game-launcher-web", "game-controller", "games"];

// Where the launcher lives inside the tree — the redirect target below and the
// launcher's own `../games/` expectation both depend on this name.
const LAUNCHER = "game-launcher-web";

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
}

// Root redirect, so the bare domain lands on the TV app. Kept as a meta refresh
// (plus an immediate JS replace) so it works without any server-side routing.
fs.writeFileSync(path.join(OUT, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Space Console</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=./${LAUNCHER}/">
<script>location.replace("./${LAUNCHER}/" + location.search);</script>
</head>
<body>Opening Space Console… <a href="./${LAUNCHER}/">continue</a>.</body>
</html>
`);

console.log(`[build] static tree ready at ${OUT}`);
