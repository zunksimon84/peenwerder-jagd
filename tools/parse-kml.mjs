#!/usr/bin/env node
// Convert the Peenwerder My Map KML into public/posts.json.
// Usage:
//   node tools/parse-kml.mjs                       # fetches the live My Map
//   node tools/parse-kml.mjs path/to/file.kml      # reads a local file
//   node tools/parse-kml.mjs https://...kml        # fetches a URL

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const DEFAULT_KML = "https://www.google.com/maps/d/kml?mid=1Mz4DY_G8uTFDT14YNepjb8vLbjwF6lM&forcekml=1";

const AREA_PREFIX = {
  "Peenwerder Hauptrevier": "HR",
  "Peenwerder Ost": "OST",
  "Peenwerder Nord": "N",
  "Peenwerder Nordrand": "NR",
};

async function loadKml(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return await res.text();
  }
  return await readFile(source, "utf8");
}

// KML from My Maps puts each layer in a top-level <Folder> with <name>…</name>.
// Each folder contains <Placemark> nodes; we only want the ones with <Point>.
function parseFolders(kml) {
  const folders = [];
  const re = /<Folder>([\s\S]*?)<\/Folder>/g;
  let m;
  while ((m = re.exec(kml)) !== null) {
    const body = m[1];
    const nameMatch = body.match(/<name>([^<]+)<\/name>/);
    const folderName = nameMatch ? decodeXml(nameMatch[1].trim()) : "Unknown";
    folders.push({ name: folderName, body });
  }
  return folders;
}

function parsePointPlacemarks(body) {
  const out = [];
  const re = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const inner = m[1];
    if (!/<Point>/.test(inner)) continue; // skip polygons & linestrings
    const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
    const coordMatch = inner.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
    if (!nameMatch || !coordMatch) continue;
    const name = decodeXml(nameMatch[1].trim());
    const [lng, lat] = coordMatch[1].trim().split(",").map(Number);
    if (Number.isNaN(lng) || Number.isNaN(lat)) continue;
    out.push({ name, lat, lng });
  }
  return out;
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// We keep posts whose name starts with "Nr" (Hochsitz/Kanzel) or "DJB"
// (Drückjagdbock). Both are recognisable hunting-post names.
function isHuntingPost(name) {
  return /^(Nr\.?|DJB)\s*\d+/i.test(name);
}

function postNumber(name) {
  const m = name.match(/^(?:Nr\.?|DJB)\s*([\dA-Za-z]+)/i);
  return m ? m[1] : null;
}

function postKind(name) {
  return /^DJB/i.test(name) ? "DJB" : "Nr";
}

async function main() {
  const arg = process.argv[2] ?? DEFAULT_KML;
  const kml = await loadKml(arg);
  const folders = parseFolders(kml);

  if (folders.length === 0) {
    throw new Error("No <Folder> elements found in KML.");
  }

  const posts = [];
  for (const folder of folders) {
    const prefix = AREA_PREFIX[folder.name];
    if (!prefix) continue; // ignore unrelated folders
    const placemarks = parsePointPlacemarks(folder.body);
    for (const pm of placemarks) {
      if (!isHuntingPost(pm.name)) continue;
      const num = postNumber(pm.name) ?? "X";
      const kind = postKind(pm.name);
      const idCore = kind === "DJB" ? `DJB${num}` : num;
      posts.push({
        id: `${prefix}-${idCore.toUpperCase()}`,
        name: pm.name,
        area: folder.name.replace(/^Peenwerder\s+/, ""),
        kind,
        lat: pm.lat,
        lng: pm.lng,
      });
    }
  }

  // Detect duplicate IDs (same number in same area) and suffix them.
  const seen = new Map();
  for (const p of posts) {
    const n = (seen.get(p.id) ?? 0) + 1;
    seen.set(p.id, n);
    if (n > 1) p.id = `${p.id}-${n}`;
  }

  posts.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "../public/posts.json");
  await writeFile(outPath, JSON.stringify(posts, null, 2) + "\n");

  const byArea = posts.reduce((acc, p) => ((acc[p.area] = (acc[p.area] ?? 0) + 1), acc), {});
  console.error(`Wrote ${posts.length} posts to ${outPath}`);
  for (const [area, n] of Object.entries(byArea)) console.error(`  ${area}: ${n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
