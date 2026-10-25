let cachedToken = null;
let tokenExpiry = 0;

const PLATFORMS_MAP = {
  6: "PC", 167: "PS5", 48: "PS4", 9: "PS3", 8: "PS2", 7: "PlayStation",
  169: "Xbox Series X|S", 11: "Xbox", 12: "Xbox 360", 130: "Nintendo Switch",
  508: "Switch 2", 21: "GameCube", 4: "Nintendo 64", 19: "SNES", 18: "NES",
  33: "Game Boy", 22: "Game Boy Color", 24: "Game Boy Advance", 20: "Nintendo DS",
  37: "Nintendo 3DS", 23: "Dreamcast", 32: "Sega Saturn", 29: "Mega Drive", 64: "Master System"
};

const FILTERS = { pc: 6, ps5: 167, xbox: 169, switch2: 508 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function getToken(env) {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("CLIENT_ID ou CLIENT_SECRET manquant.");
  }
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${env.CLIENT_ID.trim()}&client_secret=${env.CLIENT_SECRET.trim()}&grant_type=client_credentials`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`Erreur jeton Twitch (${res.status})`);
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

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    let month = url.searchParams.get("month");
    const searchQuery = (url.searchParams.get("search") || "").replace(/["\\;]/g, "").trim();
    const platformParam = url.searchParams.get("platform");

    if (!searchQuery && !month) month = new Date().toISOString().slice(0, 7);

    const cacheKey = new Request(url.origin + "/v15" + url.search);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    try {
      let queryBody = "";

      if (searchQuery) {
        // On extrait le premier mot clé principal (ex: "wind" ou "zelda") ou on utilise le terme de recherche global
        const terms = searchQuery.split(" ");
        const mainTerm = terms.length > 1 ? terms[terms.length - 1] : searchQuery;
        
        queryBody = `
          fields name, summary, hypes, total_rating_count, rating, aggregated_rating, cover.image_id,
                 release_dates.date, release_dates.platform, release_dates.platform.name, release_dates.human, genres.name;
          where name ~ *"${searchQuery}"* | name ~ *"${mainTerm}"*;
          limit 40;
        `;
      } else {
        const [y, m] = month.split("-").map(Number);
        const start = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
        const end = Math.floor(Date.UTC(y, m, 1) / 1000);
        const platformIds = platformParam ? [FILTERS[platformParam]] : Object.keys(PLATFORMS_MAP).map(Number);
        
        queryBody = `
          fields name, summary, hypes, total_rating_count, rating, aggregated_rating, cover.image_id,
                 release_dates.date, release_dates.platform, release_dates.platform.name, release_dates.human, genres.name;
          where release_dates.date >= ${start} & release_dates.date < ${end} & release_dates.platform = (${platformIds.join(",")}) & cover != null;
          limit 500;
        `;
      }

      const raw = await igdb(env, queryBody);

      const games = [];
      for (const g of (raw || [])) {
        const byPlatform = {};
        for (const r of (g.release_dates || [])) {
          const platName = (r.platform && r.platform.name) || PLATFORMS_MAP[r.platform] || "Rétro";
          const rDate = r.date ? iso(r.date) : "2002-12-13";
          if (!byPlatform[platName]) {
            byPlatform[platName] = { platformName: platName, date: rDate, human: r.human || "" };
          }
        }

        let releases = Object.values(byPlatform);
        if (!releases.length) {
          releases = [{ platform: "GameCube", date: "2002-12-13", human: "", exact: false }];
        }

        games.push({
          id: g.id,
          name: g.name,
          summary: g.summary || null,
          genres: (g.genres || []).map(genre => genre.name),
          cover: g.cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : "",
          hypes: (g.hypes || 0) + (g.total_rating_count || 0),
          rating: g.rating || null,
          aggregated_rating: g.aggregated_rating || null,
          date: releases[0].date,
          releases,
        });
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
