let cachedToken = null;
let tokenExpiry = 0;

// Noms courts affichés (numéro de plateforme IGDB -> nom)
const PLATFORM_NAMES = {
  6: "PC", 167: "PS5", 48: "PS4", 9: "PS3", 8: "PS2", 7: "PS1",
  169: "Xbox", 49: "Xbox One", 12: "Xbox 360", 11: "Xbox (original)",
  508: "Switch 2", 130: "Switch", 41: "Wii U", 5: "Wii", 21: "GameCube", 4: "Nintendo 64",
  19: "SNES", 18: "NES", 33: "Game Boy", 22: "Game Boy Color", 24: "Game Boy Advance",
  20: "Nintendo DS", 37: "Nintendo 3DS", 23: "Dreamcast", 32: "Saturn",
  29: "Mega Drive", 64: "Master System",
};
// Plateformes affichées dans la liste mensuelle
const MONTH_PLATFORMS = [6, 167, 169, 508];
const FILTERS = { pc: 6, ps5: 167, xbox: 169, switch2: 508 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Corrections manuelles : numéro IGDB du jeu -> vraie date de sortie (AAAA-MM-JJ)
const DATE_FIXES = {
  305160: "2026-10-06", // Gears of War: E-Day
};

// Types de jeux gardés : 0 jeu, 4 extension autonome, 8 remake, 9 remaster, 10 édition étendue, 11 portage
const GAME_TYPES = "(0,4,8,9,10,11)";

// Vrai si le texte de date d'IGDB contient un jour (« Oct 06, 2026 »), faux sinon (« Oct 2026 »)
const hasDay = (h) =>
  /(^|\D)\d{1,2}(\D|$)/.test(String(h).replace(/\d{4}/, "").replace(/Q\d/gi, ""));

const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function getToken(env) {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("CLIENT_ID ou CLIENT_SECRET manquant dans Cloudflare.");
  }
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${env.CLIENT_ID.trim()}&client_secret=${env.CLIENT_SECRET.trim()}&grant_type=client_credentials`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`Échec jeton Twitch (${res.status}) : ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 600) * 1000;
  return cachedToken;
}

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

// Une sortie IGDB -> { id, name } de plateforme
function platformOf(r) {
  const p = r.platform;
  const id = p && typeof p === "object" ? p.id : p;
  const name = PLATFORM_NAMES[id] || (p && typeof p === "object" ? p.name : null);
  return { id, name };
}

// Transforme les jeux IGDB en liste propre pour l'application
function buildGames(raw, { allowedIds, start, end, month, searchMode }) {
  const games = [];
  for (const g of raw || []) {
    const byPlatform = {};
    for (const r of g.release_dates || []) {
      if (!r.date) continue;
      const { id, name } = platformOf(r);
      if (!name) continue;
      if (allowedIds && !allowedIds.includes(id)) continue;
      if (start && (r.date < start || r.date >= end)) continue;
      if (!byPlatform[name] || r.date < byPlatform[name].date) {
        byPlatform[name] = { date: r.date, human: r.human || "" };
      }
    }
    let releases = Object.entries(byPlatform)
      .map(([platform, r]) => ({
        platform,
        date: iso(r.date),
        human: r.human,
        exact: hasDay(r.human),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const fix = DATE_FIXES[g.id];
    if (fix) {
      if (!searchMode && fix.slice(0, 7) !== month) continue;
      releases = releases.map((r) => ({ ...r, date: fix, exact: true }));
    }
    if (!releases.length) continue;

    const developers = [];
    const publishers = [];
    if (g.involved_companies) {
      for (const ic of g.involved_companies) {
        if (ic.company && ic.company.name) {
          if (ic.developer) developers.push(ic.company.name);
          if (ic.publisher) publishers.push(ic.company.name);
        }
      }
    }

    games.push({
      id: g.id,
      name: g.name,
      summary: g.summary || null,
      developer: developers.join(", ") || null,
      publisher: publishers.join(", ") || null,
      genres: (g.genres || []).map((x) => x.name),
      cover: g.cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : "",
      hypes: (g.hypes || 0) + (g.total_rating_count || 0),
      rating: g.rating || null,
      aggregated_rating: g.aggregated_rating || null,
      date: releases[0].date,
      releases,
    });
  }
  return games;
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

const TARGET_LANGS = { fr: "french", ja: "japanese", de: "german", es: "spanish", zh: "chinese", pt: "portuguese", ko: "korean", it: "italian" };

async function translateSummary(idParam, lang, env, ctx) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "id invalide" }, { status: 400, headers: CORS });
  }
  if (!env.AI) {
    return Response.json(
      { error: "Traduction non activée : il manque le binding AI sur le Worker" },
      { status: 500, headers: CORS }
    );
  }
  const key = new Request(`https://sorties-jeux.cache/tr/${id}/${lang}`);
  const hit = await cacheGet(key);
  if (hit) return hit;
  try {
    const raw = await igdb(env, `fields summary; where id = ${id};`);
    const text = raw[0] && raw[0].summary;
    if (!text) return Response.json({ id, summary: null }, { headers: CORS });
    if (lang === "en") return Response.json({ id, summary: text }, { headers: CORS });
    const out = [];
    for (const chunk of splitText(text)) {
      const r = await env.AI.run("@cf/meta/m2m100-1.2b", {
        text: chunk,
        source_lang: "english",
        target_lang: TARGET_LANGS[lang] || "french",
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handlePromosRequest() {
  try {
    // Appel direct à l'API officielle Steam pour récupérer les featured/discounts du jour
    const response = await fetch("https://store.steampowered.com/api/featuredcategories/?l=french", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CartridgeApp/1.0"
      }
    });

    if (!response.ok) throw new Error("Erreur flux officiel Steam");
    const data = await response.json();

    // Steam classe les promos dans différentes catégories (ex: specials)
    const specials = data.specials ? data.specials.items : [];

    const steamDeals = specials.map(game => ({
      id: "steam-" + game.id,
      name: game.name,
      releases: [{ platform: "PC", date: new Date().toISOString().slice(0, 10), human: "Soldes Steam", exact: true }],
      store: "Steam Store",
      cover: game.header_image || game.large_capsule_image,
      oldPrice: (game.original_price / 100).toFixed(2) + " €",
      newPrice: (game.final_price / 100).toFixed(2) + " €",
      discount: `-${game.discount_percent}%`
    }));

    return Response.json(steamDeals, {
      headers: { ...CORS, "Cache-Control": "public, max-age=1800" }
    });
  } catch (err) {
    return Response.json({ error: err.message, deals: [] }, { status: 500, headers: CORS });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/api/promos") {
      return handlePromosRequest();
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  }
};

    let month = url.searchParams.get("month");
    const searchQuery = (url.searchParams.get("search") || "").replace(/["\\;]/g, "").trim();
    const platformParam = url.searchParams.get("platform");
    const showAll = url.searchParams.get("all") === "1";

    if (platformParam && !FILTERS[platformParam]) {
      return Response.json({ error: "platform doit valoir : pc, ps5, xbox ou switch2" }, { status: 400, headers: CORS });
    }
    if (!searchQuery && !month) month = new Date().toISOString().slice(0, 7);
    if (!searchQuery && !/^\d{4}-\d{2}$/.test(month)) {
      return Response.json({ error: "Format attendu : ?month=YYYY-MM" }, { status: 400, headers: CORS });
    }

    const cacheKey = new Request(url.origin + "/v22" + url.search);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    try {
      let games;

      if (searchQuery) {
        const words = searchQuery.split(/\s+/).filter(Boolean).slice(0, 5);
        const contains = words.map((w) => `name ~ *"${w}"*`).join(" & ");
        const poolFields = "fields name, hypes, total_rating_count;";
        const attempts = [
          `search "${searchQuery}"; ${poolFields} where game_type = ${GAME_TYPES}; limit 500;`,
          `${poolFields} where ${contains} & game_type = ${GAME_TYPES}; limit 500;`,
          `search "${searchQuery}"; ${poolFields} limit 500;`,
        ];
        let pool = [];
        for (const q of attempts) {
          pool = await igdb(env, q);
          if (pool && pool.length) break;
        }
        const lowerWords = words.map((w) => w.toLowerCase());
        const poolScore = (g) => {
          const n = (g.name || "").toLowerCase();
          return (lowerWords.every((w) => n.includes(w)) ? 1e6 : 0) + (g.hypes || 0) + (g.total_rating_count || 0);
        };
        const topIds = pool.sort((a, b) => poolScore(b) - poolScore(a)).slice(0, 40).map((g) => g.id);
        let raw = [];
        if (topIds.length) {
          raw = await igdb(env, `
            fields name, summary, hypes, total_rating_count, rating, aggregated_rating, cover.image_id, genres.name,
                   release_dates.date, release_dates.platform.name, release_dates.human,
                   involved_companies.company.name, involved_companies.developer, involved_companies.publisher;
            where id = (${topIds.join(",")});
            limit 50;
          `);
        }
        games = buildGames(raw, { allowedIds: null, searchMode: true });
        const gameScore = (g) => (lowerWords.every((w) => g.name.toLowerCase().includes(w)) ? 1e6 : 0) + g.hypes;
        games.sort((a, b) => gameScore(b) - gameScore(a));
      } else {
        const [y, m] = month.split("-").map(Number);
        const start = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
        const end = Math.floor(Date.UTC(y, m, 1) / 1000);
        const platformIds = platformParam ? [FILTERS[platformParam]] : (month < "2020-11" ? Object.keys(PLATFORM_NAMES).map(Number) : MONTH_PLATFORMS);

        let where = `game_type = ${GAME_TYPES} & cover != null`;
        where += ` & release_dates.date >= ${start} & release_dates.date < ${end}`;
        where += ` & release_dates.platform = (${platformIds.join(",")})`;
        if (!showAll) where += " & (hypes > 0 | total_rating_count >= 5 | game_type = (8,9))";

        const raw = await igdb(env, `
          fields name, summary, hypes, total_rating_count, rating, aggregated_rating, cover.image_id, genres.name,
                 release_dates.date, release_dates.platform, release_dates.human,
                 involved_companies.company.name, involved_companies.developer, involved_companies.publisher;
          where ${where};
          limit 500;
        `);
        games = buildGames(raw, { allowedIds: platformIds, start, end, month, searchMode: false });
        games.sort((a, b) => a.date.localeCompare(b.date) || b.hypes - a.hypes);
      }

      const response = Response.json(games, {
        headers: { ...CORS, "Cache-Control": "public, max-age=600" },
      });
      cachePut(ctx, cacheKey, response.clone());
      return response;
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers: CORS });
    }
  },
};
