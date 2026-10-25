let cachedToken = null;
let tokenExpiry = 0;

// Table complète des identifiants IGDB pour les consoles actuelles ET rétro
const PLATFORMS = {
  6: "PC",
  167: "PS5",
  48: "PS4",
  9: "PS3",
  8: "PS2",
  7: "PlayStation",
  169: "Xbox Series X|S",
  11: "Xbox One",
  12: "Xbox 360",
  11: "Xbox",
  130: "Nintendo Switch",
  508: "Switch 2",
  21: "GameCube",
  4: "Nintendo 64",
  19: "SNES",
  18: "NES",
  33: "Game Boy",
  22: "Game Boy Color",
  24: "Game Boy Advance",
  20: "Nintendo DS",
  37: "Nintendo 3DS",
  23: "Dreamcast",
  32: "Sega Saturn",
  29: "Sega Mega Drive / Genesis",
  64: "Sega Master System"
};

const FILTERS = { pc: 6, ps5: 167, xbox: 169, switch2: 508 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const LANG_MAP = {
  fr: "french",
  en: "english",
  ja: "japanese",
  de: "german",
  es: "spanish",
  zh: "chinese",
  pt: "portuguese",
  ko: "korean",
  it: "italian"
};

const DATE_FIXES = {
  305160: "2026-10-06", // Gears of War: E-Day
};

const hasDay = (h) =>
  /(^|\D)\d{1,2}(\D|$)/.test(String(h).replace(/\d{4}/, "").replace(/Q\d/gi, ""));

async function getToken(env) {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("CLIENT_ID ou CLIENT_SECRET manquant dans Cloudflare.");
  }
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${env.CLIENT_ID.trim()}&client_secret=${env.CLIENT_SECRET.trim()}&grant_type=client_credentials`,
    { method: "POST" }
  );
  if (!res.ok) {
    throw new Error(`Échec jeton Twitch (${res.status}) : ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 600) * 1000;
  return cachedToken;
}

const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function cacheGet(key) {
  try { return await caches.default.match(key); } catch (e) { return undefined; }
}
function cachePut(ctx, key, response) {
  try { ctx.waitUntil(caches.default.put(key, response).catch(() => {})); } catch (e) {}
}

async function igdb(env, query) {
  const token = await getToken(env);
  const res = await fetch("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: {
      "Client-ID": env.CLIENT_ID.trim(),
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body: query,
  });
  if (!res.ok) throw new Error(`Erreur IGDB (${res.status}) : ${await res.text()}`);
  return res.json();
}

function splitText(text, max = 400) {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const chunks = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > max) {
      if (cur) { chunks.push(cur); cur = ""; }
      chunks.push(s.slice(0, max));
      s = s.slice(max);
    }
    if ((cur + " " + s).trim().length > max) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = (cur + " " + s).trim();
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function translateSummary(idParam, langParam, env, ctx) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "id invalide" }, { status: 400, headers: CORS });
  }

  const lang = (langParam || "fr").toLowerCase();
  const targetLang = LANG_MAP[lang] || "french";

  const key = new Request(`https://sorties-jeux.cache/tr/${id}/${lang}`);
  const hit = await cacheGet(key);
  if (hit) return hit;

  try {
    const raw = await igdb(env, `fields summary; where id = ${id};`);
    const text = raw[0] && raw[0].summary;
    if (!text) return Response.json({ id, summary: null }, { headers: CORS });

    if (lang === "en") {
      const response = Response.json(
        { id, summary: text },
        { headers: { ...CORS, "Cache-Control": "public, max-age=2592000" } }
      );
      cachePut(ctx, key, response.clone());
      return response;
    }

    if (!env.AI) {
      return Response.json(
        { error: "Traduction non activée : il manque le binding AI sur le Worker" },
        { status: 500, headers: CORS }
      );
    }

    const out = [];
    for (const chunk of splitText(text)) {
      const r = await env.AI.run("@cf/meta/m2m100-1.2b", {
        text: chunk,
        source_lang: "english",
        target_lang: targetLang,
      });
      out.push(r.translated_text);
    }

    const response = Response.json(
      { id, summary: out.join(" ") },
      { headers: { ...CORS, "Cache-Control": "public, max-age=2592000" } }
    );
    cachePut(ctx, key, response.clone());
    return response;
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.searchParams.has("translate")) {
      return translateSummary(url.searchParams.get("translate"), url.searchParams.get("lang"), env, ctx);
    }

    let month = url.searchParams.get("month");
    const searchQuery = (url.searchParams.get("search") || "").replace(/["\\;]/g, "").trim();
    const platformParam = url.searchParams.get("platform");
    const showAll = url.searchParams.get("all") === "1";

    if (platformParam && !FILTERS[platformParam]) {
      return Response.json({ error: "platform invalide" }, { status: 400, headers: CORS });
    }
    if (!searchQuery && !month) month = new Date().toISOString().slice(0, 7);
    if (!searchQuery && !/^\d{4}-\d{2}$/.test(month)) {
      return Response.json({ error: "Format attendu : ?month=YYYY-MM" }, { status: 400, headers: CORS });
    }

    // V7 de la clé de cache pour rafraîchir les données des consoles rétro
    const cacheKey = new Request(url.origin + "/v7" + url.search);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    try {
      const platformIds = platformParam
        ? [FILTERS[platformParam]]
        : Object.keys(PLATFORMS).map(Number);

      let start = 0, end = 0;
      let where = "game_type = (0,8,9,11) & cover != null";
      let tail;
      if (searchQuery) {
        where += ` & release_dates != null & name ~ *"${searchQuery}"*`;
        tail = "limit 40;";
      } else {
        const [y, m] = month.split("-").map(Number);
        start = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
        end = Math.floor(Date.UTC(y, m, 1) / 1000);
        where += ` & release_dates.date >= ${start} & release_dates.date < ${end}`;
        where += ` & release_dates.platform = (${platformIds.join(",")})`;
        if (!showAll) where += " & (hypes > 0 | total_rating_count >= 5)";
        tail = "limit 500;";
      }

      const raw = await igdb(env, `
        fields name, summary, hypes, total_rating_count, rating, aggregated_rating, cover.image_id,
               release_dates.date, release_dates.platform, release_dates.human, genres.name;
        where ${where};
        ${tail}
      `);

      const games = [];
      for (const g of raw) {
        const byPlatform = {};
        for (const r of g.release_dates || []) {
          if (!r.date) continue;
          // Si c'est une recherche, on inclut toutes les consoles reconnues
          if (!searchQuery && !platformIds.includes(r.platform)) continue;
          if (!searchQuery && (r.date < start || r.date >= end)) continue;
          
          const platName = PLATFORMS[r.platform] || r.human || "Retro";
          if (!byPlatform[r.platform] || r.date < byPlatform[r.platform].date) {
            byPlatform[r.platform] = { platformName: platName, date: r.date, human: r.human || "" };
          }
        }
        
        let releases = Object.values(byPlatform)
          .map((r) => ({
            platform: r.platformName,
            date: iso(r.date),
            human: r.human,
            exact: hasDay(r.human),
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
          
        const fix = DATE_FIXES[g.id];
        if (fix) {
          if (!searchQuery && fix.slice(0, 7) !== month) continue;
          releases = releases.map((r) => ({ ...r, date: fix, exact: true }));
        }
        if (!releases.length) continue;

        const genreList = (g.genres || []).map(genre => genre.name);

        games.push({
          id: g.id,
          name: g.name,
          summary: g.summary || null,
          genres: genreList,
          cover: `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg`,
          hypes: (g.hypes || 0) + (g.total_rating_count || 0),
          rating: g.rating || null,
          aggregated_rating: g.aggregated_rating || null,
          timeToBeat: null,
          date: releases[0].date,
          releases,
        });
      }
      if (searchQuery) {
        games.sort((a, b) => b.hypes - a.hypes || b.date.localeCompare(a.date));
      } else {
        games.sort((a, b) => a.date.localeCompare(b.date) || b.hypes - a.hypes);
      }

      const response = Response.json(games, {
        headers: { ...CORS, "Cache-Control": "public, max-age=3600" },
      });
      cachePut(ctx, cacheKey, response.clone());
      return response;
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  },
};
