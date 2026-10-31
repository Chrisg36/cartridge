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
  // « Authorization » est indispensable : la sauvegarde envoie le jeton de connexion dans cet en-tête
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
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

async function igdb(env, query, retried = false) {
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
  // Jeton révoqué ou expiré plus tôt que prévu : on en redemande un (une seule fois)
  if (res.status === 401 && !retried) { cachedToken = null; tokenExpiry = 0; return igdb(env, query, true); }
  if (!res.ok) throw new Error(`Erreur IGDB (${res.status}) : ${await res.text()}`);
  return res.json();
}

// Une sortie IGDB -> { id, name } de plateforme (l'IGDB renvoie un nombre ou un objet)
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
      if (start && (r.date < start || r.date >= end)) continue; // seulement le mois demandé
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
    if (!releases.length) continue; // pas de date connue : on n'invente rien

    const developers = [];
    const publishers = [];
    for (const ic of g.involved_companies || []) {
      if (ic.company && ic.company.name) {
        if (ic.developer) developers.push(ic.company.name);
        if (ic.publisher) publishers.push(ic.company.name);
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
      hypes: (g.hypes || 0) + (g.total_rating_count || 0), // score de popularité
      rating: g.rating || null,
      aggregated_rating: g.aggregated_rating || null,
      date: releases[0].date,
      releases,
    });
  }
  return games;
}

// Découpe un texte en morceaux de 400 caractères maximum, à la fin d'une phrase
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

// Langues de traduction (code de la page -> nom attendu par les modèles)
const TARGET_LANGS = { fr: "french", ja: "japanese", de: "german", es: "spanish", zh: "chinese", pt: "portuguese", ko: "korean", it: "italian" };

// Modèle principal : un vrai modèle de langage, qui comprend le contexte des jeux vidéo
const TRANSLATE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// Modèle de secours (l'ancien traducteur mot à mot) si le principal ne répond pas
const FALLBACK_MODEL = "@cf/meta/m2m100-1.2b";

// Table D1 des traductions déjà faites (créée automatiquement la première fois).
// « translations_v2 » : nouvelle table, pour que tous les résumés soient retraduits avec le nouveau modèle.
let trTableReady = false;
async function ensureTrTable(env) {
  if (trTableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS translations_v2 (game_id INTEGER NOT NULL, lang TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (game_id, lang))"
  ).run();
  trTableReady = true;
}

// Traduction avec le modèle principal (consignes de traducteur spécialisé jeux vidéo)
async function translateWithLLM(env, text, lang) {
  const language = TARGET_LANGS[lang].charAt(0).toUpperCase() + TARGET_LANGS[lang].slice(1);
  const r = await env.AI.run(TRANSLATE_MODEL, {
    messages: [
      {
        role: "system",
        content:
          `You are a professional video game localizer. Translate the user's English game summary into natural, fluent ${language}, ` +
          `as written by the ${language}-language gaming press. Rules: keep proper nouns unchanged (game titles, characters, places, ` +
          `studios, items); use the standard video game terms that ${language}-speaking players actually use (for example keep ` +
          `"cel-shading", "roguelike", "metroidvania", "open world" style terms in English when that is the usual practice); ` +
          `keep line breaks; do not add, remove or explain anything. Output only the translation, with no quotes and no preamble.`,
      },
      { role: "user", content: text },
    ],
    max_tokens: 2048,
    temperature: 0.2,
  });
  let out = (r && (r.response ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) || "";
  out = String(out).trim()
    .replace(/^(voici (la|une) traduction[^:\n]*:|traduction\s*:|translation\s*:)\s*/i, "")
    .replace(/^["«“]\s*([\s\S]*?)\s*["»”]$/, "$1")
    .trim();
  // Garde-fou : une réponse vide, ou de longueur aberrante, n'est pas une traduction
  if (out.length < text.length * 0.4 || out.length > text.length * 3) throw new Error("Traduction suspecte");
  return out;
}

// Traduction avec le modèle de secours (morceau par morceau)
async function translateWithFallback(env, text, lang) {
  const out = [];
  for (const chunk of splitText(text)) {
    const r = await env.AI.run(FALLBACK_MODEL, { text: chunk, source_lang: "english", target_lang: TARGET_LANGS[lang] });
    if (!r || !r.translated_text) throw new Error("Traduction vide renvoyée par l'IA");
    out.push(r.translated_text);
  }
  return out.join(" ");
}

// Traduction du résumé d'un jeu (anglais -> langue choisie)
// Ordre : base D1 -> modèle principal (rangé dans D1) -> modèle de secours (non rangé, retenté plus tard)
async function translateSummary(idParam, langParam, env, ctx) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "id invalide" }, { status: 400, headers: CORS });
  }
  const lang = langParam === "en" || TARGET_LANGS[langParam] ? langParam : "fr";
  const okHeaders = { ...CORS, "Cache-Control": "public, max-age=2592000" };

  // 1) Déjà traduit ? On le reprend dans la base D1
  let dbError = env.DB ? null : "binding DB manquant";
  if (env.DB && lang !== "en") {
    try {
      await ensureTrTable(env);
      const row = await env.DB.prepare("SELECT summary FROM translations_v2 WHERE game_id = ? AND lang = ?")
        .bind(id, lang).first();
      if (row) return Response.json({ id, summary: row.summary, saved: true }, { headers: okHeaders });
    } catch (e) { dbError = e.message; }
  }

  if (!env.AI) {
    return Response.json(
      { error: "Traduction non activée : il manque le binding AI sur le Worker" },
      { status: 500, headers: CORS }
    );
  }
  try {
    const raw = await igdb(env, `fields summary; where id = ${id};`);
    const text = raw[0] && raw[0].summary;
    if (!text) return Response.json({ id, summary: null }, { headers: CORS });
    if (lang === "en") return Response.json({ id, summary: text }, { headers: CORS });

    // 2) Traduction par le modèle principal ; en cas d'échec, modèle de secours
    let summary, model = "llm";
    try {
      summary = await translateWithLLM(env, text, lang);
    } catch (e) {
      summary = await translateWithFallback(env, text, lang);
      model = "secours";
    }

    // 3) On range la traduction dans D1 (seulement celle du modèle principal)
    if (env.DB && !dbError && model === "llm") {
      try {
        await env.DB.prepare("INSERT OR REPLACE INTO translations_v2 (game_id, lang, summary, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, lang, summary, Math.floor(Date.now() / 1000)).run();
      } catch (e) { dbError = e.message; }
    }

    const body = { id, summary, saved: false, model };
    if (dbError) body.db_error = dbError;
    return Response.json(body, { headers: dbError || model !== "llm" ? CORS : okHeaders });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
  }
}


// =====================================================================
//  NOTES & TESTS : ?reviews=ID_IGDB
//  Sources : IGDB (note presse + note joueurs), avis Steam (gratuit, sans clé),
//  OpenCritic (seulement si le secret RAPIDAPI_KEY existe : offre gratuite 200 req/jour).
//  Tout est rangé dans la table D1 « reviews » et revérifié tout seul selon la date de sortie.
// =====================================================================
const DAY = 86400;
// Version des notes : l'augmenter force la revérification de tous les jeux déjà enregistrés
const RV_VERSION = 2;
const STEAM_LABELS = {
  9: "Extrêmement positives", 8: "Très positives", 7: "Positives", 6: "Plutôt positives",
  5: "Moyennes", 4: "Plutôt négatives", 3: "Négatives", 2: "Très négatives", 1: "Extrêmement négatives",
};
const OC_HOST = "opencritic-api.p.rapidapi.com";
const OC_DAILY_MAX = 180; // marge sous les 200 requêtes/jour gratuites
const OC_SEARCH_MAX = 20; // marge sous les 25 recherches/jour gratuites

let rvTablesReady = false;
async function ensureRvTables(env) {
  if (rvTablesReady) return;
  await env.DB.batch([
    // oc_id : null = jamais cherché, 0 = pas trouvé sur OpenCritic, sinon son numéro
    env.DB.prepare("CREATE TABLE IF NOT EXISTS reviews (game_id INTEGER PRIMARY KEY, data TEXT NOT NULL, oc_id INTEGER, checked_at INTEGER NOT NULL, next_check INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS api_quota (key TEXT PRIMARY KEY, n INTEGER NOT NULL)"),
  ]);
  rvTablesReady = true;
}

// Compte un appel du jour ; renvoie faux si le plafond du jour est atteint
async function takeQuota(env, kind, max) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "INSERT INTO api_quota (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(kind + ":" + today).first();
  if (row && row.n === 1) {
    // premier appel du jour : on efface les compteurs des jours passés
    await env.DB.prepare("DELETE FROM api_quota WHERE key NOT LIKE ?").bind("%:" + today).run();
  }
  return !!row && row.n <= max;
}

// Quand revérifier ? Selon l'âge du jeu (négatif = pas encore sorti)
function nextCheckDelay(releaseTs, hasScore) {
  if (!releaseTs) return 7 * DAY;
  const age = nowSec() - releaseTs;
  if (age < -14 * DAY) return Math.max(DAY, Math.min(7 * DAY, -age - 14 * DAY)); // bien avant la sortie
  if (age < 45 * DAY) return hasScore ? DAY : DAY / 2; // les tests tombent : chaque jour
  if (age < 180 * DAY) return 7 * DAY;
  return 30 * DAY; // vieux jeu : la note ne bouge plus
}

// Numéro Steam du jeu, trouvé dans les liens IGDB
function findSteamId(g) {
  for (const e of g.external_games || []) {
    const isSteam = e.external_game_source === 1 || e.category === 1 || /steampowered\.com/.test(e.url || "");
    if (isSteam && /^\d+$/.test(String(e.uid || ""))) return Number(e.uid);
  }
  for (const w of g.websites || []) {
    const m = /store\.steampowered\.com\/app\/(\d+)/.exec(w.url || "");
    if (m) return Number(m[1]);
  }
  return null;
}

// Lit une réponse Steam en JSON ; si Steam renvoie une page web, message clair au lieu d'un plantage
async function steamJson(res, label) {
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error(`${label} a renvoyé une page web au lieu de données`);
  return JSON.parse(text);
}

async function steamSummary(appid) {
  let q, firstError;
  // 1) Adresse officielle actuelle (sans clé) : IUserReviewsService/GetAppReviews
  try {
    const input = { appid, languages: ["all"], purchase_type: 1, num_per_page: 1, display_language: "french" };
    const res = await fetch(
      "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/?input_json=" + encodeURIComponent(JSON.stringify(input)),
      { headers: { "User-Agent": "Cartridge/1.0", Accept: "application/json" } }
    );
    const j = await steamJson(res, "Steam API");
    q = (j.response || j).query_summary;
  } catch (e) { firstError = e; }
  // 2) Secours : l'ancienne adresse (dépréciée par Valve)
  if (!q) {
    try {
      const res = await fetch(
        `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=1`,
        { headers: { "User-Agent": "Cartridge/1.0", Accept: "application/json" } }
      );
      q = (await steamJson(res, "Steam store")).query_summary;
    } catch (e) {
      throw new Error((firstError ? firstError.message + " / " : "") + e.message);
    }
  }
  if (!q || !q.total_reviews) return null;
  return {
    appid,
    label: STEAM_LABELS[q.review_score] || q.review_score_desc || null,
    percent: Math.round((q.total_positive * 100) / q.total_reviews),
    total: q.total_reviews,
    url: `https://store.steampowered.com/app/${appid}/`,
  };
}

async function ocFetch(env, path) {
  if (!(await takeQuota(env, "oc", OC_DAILY_MAX))) throw new Error("quota");
  const r = await fetch(`https://${OC_HOST}${path}`, {
    headers: { "X-RapidAPI-Key": env.RAPIDAPI_KEY.trim(), "X-RapidAPI-Host": OC_HOST },
  });
  if (!r.ok) throw new Error("OpenCritic " + r.status);
  return r.json();
}

const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Cherche le jeu sur OpenCritic (une seule fois : le numéro est gardé dans D1)
async function ocFindId(env, name) {
  if (!(await takeQuota(env, "ocsearch", OC_SEARCH_MAX))) throw new Error("quota");
  const list = (await ocFetch(env, `/game/search?criteria=${encodeURIComponent(name)}`)) || [];
  const exact = list.find((x) => normName(x.name) === normName(name));
  if (exact) return exact.id;
  return list[0] && typeof list[0].dist === "number" && list[0].dist <= 0.15 ? list[0].id : 0;
}

async function ocDetails(env, ocId) {
  const game = await ocFetch(env, `/game/${ocId}`);
  const raw = (await ocFetch(env, `/reviews/game/${ocId}`)) || [];
  const reviews = raw
    .map((r) => {
      const outlet = r.Outlet || r.outlet || {};
      const np = typeof r.npScore === "number" && r.npScore >= 0 ? Math.round(r.npScore) : null;
      return {
        outlet: outlet.name || "Site",
        score: np, // note ramenée sur 100
        snippet: String(r.snippet || "").replace(/\s+/g, " ").trim().slice(0, 280),
        url: r.externalUrl || null,
        lang: String(r.language || "").toLowerCase().slice(0, 2),
        date: r.publishedDate ? String(r.publishedDate).slice(0, 10) : null,
      };
    })
    .filter((r) => r.url)
    // les tests en français d'abord, puis ceux qui ont une note
    .sort((a, b) => (b.lang === "fr") - (a.lang === "fr") || (b.score != null) - (a.score != null))
    .slice(0, 10);
  const score = typeof game.topCriticScore === "number" && game.topCriticScore >= 0 ? Math.round(game.topCriticScore) : null;
  return {
    score,
    tier: game.tier || null,
    count: game.numReviews || 0,
    percent: typeof game.percentRecommended === "number" && game.percentRecommended >= 0 ? Math.round(game.percentRecommended) : null,
    url: game.url || `https://opencritic.com/game/${ocId}/-`,
    reviews,
  };
}

async function getReviews(idParam, env, refresh) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return jsonRes({ error: "id invalide" }, 400);
  if (!env.DB) return jsonRes({ error: "binding DB manquant" }, 500);

  try {
    await ensureRvTables(env);
    const row = await env.DB.prepare("SELECT data, oc_id, next_check FROM reviews WHERE game_id = ?").bind(id).first();
    // &refresh=1 : force une nouvelle vérification (les plafonds OpenCritic restent appliqués)
    const old = row ? JSON.parse(row.data) : {};
    // Résultat encore frais ET fait par la version actuelle du code ? On le renvoie tel quel.
    if (row && row.next_check > nowSec() && old.v === RV_VERSION && !refresh) {
      return Response.json(old, { headers: { ...CORS, "Cache-Control": "public, max-age=60" } });
    }
    let ocId = row ? row.oc_id : null;

    // 1) IGDB : notes + liens (pour trouver le jeu sur Steam)
    const [g] = await igdb(env, `
      fields name, first_release_date, aggregated_rating, aggregated_rating_count, rating, rating_count,
             external_games.*, websites.url;
      where id = ${id};
    `);
    if (!g) return jsonRes({ error: "jeu introuvable" }, 404);
    const releaseTs = g.first_release_date || null;
    const released = releaseTs && releaseTs - nowSec() < 14 * DAY; // sorti, ou tests imminents

    const data = {
      v: RV_VERSION,
      id,
      name: g.name,
      igdb: {
        critics: g.aggregated_rating ? Math.round(g.aggregated_rating) : null,
        criticsCount: g.aggregated_rating_count || 0,
        players: g.rating ? Math.round(g.rating) : null,
        playersCount: g.rating_count || 0,
      },
      steam: old.steam || null,
      opencritic: old.opencritic || null,
      updated: new Date().toISOString().slice(0, 10),
    };
    let retrySoon = false;
    // Diagnostic (non affiché dans l'app) : visible en ouvrant /?reviews=ID dans le navigateur
    const debug = { released: !!released, steamId: null, steam: "non vérifié", opencritic: env.RAPIDAPI_KEY ? "non vérifié" : "pas de clé RAPIDAPI_KEY" };

    // 2) Avis des joueurs Steam
    if (released) {
      const appid = findSteamId(g);
      debug.steamId = appid;
      if (!appid) {
        debug.steam = "numéro Steam introuvable dans IGDB";
        debug.igdbLinks = [
          ...(g.external_games || []).map((e) => `${e.external_game_source ?? e.category ?? "?"}:${e.uid || ""} ${e.url || ""}`.trim()),
          ...(g.websites || []).map((w) => w.url),
        ].slice(0, 15);
      } else {
        try {
          data.steam = await steamSummary(appid);
          debug.steam = data.steam ? "ok" : "aucun avis Steam pour l'instant";
        } catch (e) { retrySoon = true; debug.steam = "erreur : " + e.message; }
      }
    }

    // 3) OpenCritic (optionnel)
    if (released && env.RAPIDAPI_KEY) {
      try {
        const recent = releaseTs && nowSec() - releaseTs < 60 * DAY;
        if (ocId == null || (ocId === 0 && recent)) ocId = await ocFindId(env, g.name);
        if (ocId) data.opencritic = await ocDetails(env, ocId);
        debug.opencritic = ocId ? "ok (jeu n°" + ocId + ")" : "jeu introuvable sur OpenCritic";
      } catch (e) { retrySoon = true; debug.opencritic = "erreur : " + e.message; } // quota atteint ou panne : on garde l'ancien résultat
    }
    data.debug = debug;

    const hasScore = !!(data.igdb.critics || (data.opencritic && data.opencritic.score) || data.steam);
    const delay = retrySoon ? 6 * 3600 : nextCheckDelay(releaseTs, hasScore);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO reviews (game_id, data, oc_id, checked_at, next_check) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, JSON.stringify(data), ocId, nowSec(), nowSec() + delay).run();

    return Response.json(data, { headers: { ...CORS, "Cache-Control": "public, max-age=60" } });
  } catch (e) {
    return jsonRes({ error: e.message }, 500);
  }
}



// =====================================================================
//  BOOSTERS : ?pack=standard | retro | supreme_retro  (&exclude=id1,id2…)
//  Tire UNE jaquette selon une vraie rareté, sur le catalogue complet IGDB.
//  4 raretés :
//   - legendary (Légendaire) : « grails » du rétro, jeux réputés introuvables / très chers en boîte
//   - epic      (Épique)     : jeux rétro sortis sur des consoles rares (Neo Geo, PC Engine, Saturn JP…)
//   - rare      (Rare)       : pépites rétro 1985-2005, bien notées mais peu connues
//   - common    (Commune)    : jeux récents connus (2010 → aujourd'hui)
//  « exclude » = jeux déjà dans la vitrine du joueur : on évite les doublons.
// =====================================================================
const DETAIL_FIELDS = `fields name, summary, hypes, total_rating_count, rating, aggregated_rating, first_release_date, cover.image_id, genres.name,
  release_dates.date, release_dates.platform.name, release_dates.human,
  involved_companies.company.name, involved_companies.developer, involved_companies.publisher;`;

// Chances de chaque rareté selon le booster (total = 100)
const PACK_ODDS = {
  standard:      { common: 85, rare: 12, epic: 3, legendary: 0 },
  retro:         { common: 0, rare: 72, epic: 22, legendary: 6 },
  supreme_retro: { common: 0, rare: 0, epic: 30, legendary: 70 },
};
const RARITY_LABEL = { common: "Commune", rare: "Rare", epic: "Épique", legendary: "Légendaire" };

const Y = (y) => Math.floor(Date.UTC(y, 0, 1) / 1000);
// Consoles rétro « grand public »
const RETRO_PLATFORMS = [18, 19, 4, 21, 7, 8, 32, 23, 29, 64, 33, 22, 24, 11, 35, 59];
// Consoles rares / confidentielles : Neo Geo AES & CD, Virtual Boy, PC Engine (+CD), Mega-CD, 32X,
// Jaguar, 3DO, PC-FX, Neo Geo Pocket (+Color), WonderSwan (+Color), CD-i
const RARE_PLATFORMS = [80, 136, 87, 86, 150, 78, 30, 62, 50, 274, 119, 120, 57, 123, 117];
const MODERN_PLATFORMS = [6, 167, 169, 508, 48, 49, 130];

// Réservoirs de jeux (filtres IGDB) pour chaque rareté tirée au hasard
function poolWhere(rarity) {
  const now = Math.floor(Date.now() / 1000);
  if (rarity === "epic") {
    return `cover != null & game_type = (0,8,9,10) & release_dates.platform = (${RARE_PLATFORMS.join(",")}) & first_release_date >= ${Y(1984)} & first_release_date < ${Y(2004)} & total_rating_count >= 1`;
  }
  if (rarity === "rare") {
    // pépites : bien notées, mais peu de votes (pas les Mario / Zelda archi-connus)
    return `cover != null & game_type = (0,8,9) & release_dates.platform = (${RETRO_PLATFORMS.join(",")}) & first_release_date >= ${Y(1985)} & first_release_date < ${Y(2006)} & rating >= 65 & total_rating_count >= 3 & total_rating_count <= 90`;
  }
  // common
  return `cover != null & game_type = (0,4,8,9) & release_dates.platform = (${MODERN_PLATFORMS.join(",")}) & first_release_date >= ${Y(2010)} & first_release_date < ${now} & total_rating_count >= 20`;
}

// « Grails » : jeux rétro réputés rares / chers sur le marché de la collection (nom + année approximative)
const GRAILS = [
  // NES
  ["Little Samson", 1992], ["Stadium Events", 1987], ["Bubble Bobble Part 2", 1993], ["Panic Restaurant", 1992],
  ["The Flintstones: The Surprise at Dinosaur Peak!", 1994], ["Gimmick!", 1992], ["Power Blade 2", 1992],
  ["Snow Bros.", 1991], ["Zombie Nation", 1991], ["Recca", 1992], ["Chip 'n Dale: Rescue Rangers 2", 1993], ["DuckTales 2", 1993],
  // Super Nintendo
  ["EarthBound", 1994], ["Hagane: The Final Conflict", 1994], ["Pocky & Rocky 2", 1994], ["Wild Guns", 1994],
  ["Harvest Moon", 1996], ["Terranigma", 1995], ["Rendering Ranger: R2", 1995], ["Super Turrican 2", 1995],
  ["Demon's Crest", 1994], ["Mega Man X3", 1995], ["Mega Man 7", 1995], ["Star Ocean", 1996], ["Tales of Phantasia", 1995],
  ["Seiken Densetsu 3", 1995], ["Final Fight 3", 1995], ["Sutte Hakkun", 1998],
  // Mega Drive / Mega-CD
  ["Crusader of Centy", 1994], ["Pulseman", 1994], ["Phantasy Star IV: The End of the Millennium", 1993], ["Gley Lancer", 1992],
  ["MUSHA", 1990], ["Elemental Master", 1990], ["Mega Turrican", 1994], ["Snatcher", 1994], ["Lunar: Eternal Blue", 1994],
  ["Popful Mail", 1994], ["Alien Soldier", 1995], ["Shining Force II", 1993],
  // PC Engine / TurboGrafx
  ["Air Zonk", 1992], ["Magical Chase", 1991], ["Neutopia II", 1991], ["Lords of Thunder", 1993], ["Gate of Thunder", 1992],
  ["Castlevania: Rondo of Blood", 1993], ["Spriggan Mark 2: Re-Terraform Project", 1992],
  // Neo Geo
  ["Kizuna Encounter: Super Tag Battle", 1996], ["Metal Slug", 1996], ["The Last Blade 2", 1998], ["Garou: Mark of the Wolves", 1999],
  ["Twinkle Star Sprites", 1996], ["Blazing Star", 1998], ["Pulstar", 1995], ["Magician Lord", 1990], ["Sengoku 3", 2001],
  ["Shock Troopers", 1997], ["Neo Turf Masters", 1996],
  // Nintendo 64
  ["Conker's Bad Fur Day", 2001], ["Bomberman 64: The Second Attack!", 2000], ["Stunt Racer 64", 2000], ["Ogre Battle 64: Person of Lordly Caliber", 1999],
  ["Harvest Moon 64", 1999], ["Mischief Makers", 1997], ["Sin and Punishment", 2000],
  // PlayStation
  ["Suikoden II", 1998], ["Valkyrie Profile", 1999], ["Tail Concerto", 1998], ["Mega Man Legends 2", 2000],
  ["The Misadventures of Tron Bonne", 1999], ["Rhapsody: A Musical Adventure", 1998], ["Brigandine: The Legend of Forsena", 1998],
  ["Thousand Arms", 1998], ["Persona 2: Eternal Punishment", 2000], ["Tomba! 2: The Evil Swine Return", 1999], ["Hellnight", 1998],
  // Saturn
  ["Panzer Dragoon Saga", 1998], ["Radiant Silvergun", 1998], ["Shining Force III", 1997], ["Burning Rangers", 1998],
  ["Magic Knight Rayearth", 1995], ["Dragon Force", 1996], ["Guardian Heroes", 1996], ["Princess Crown", 1997], ["Battle Garegga", 1996],
  // Dreamcast
  ["Ikaruga", 2001], ["Cannon Spike", 2000], ["Bangai-O", 1999], ["Mars Matrix: Hyper Solid Shooting", 2000], ["Project Justice", 2000],
  ["Gunbird 2", 1998], ["Shenmue II", 2001],
  // GameCube
  ["Gotcha Force", 2003], ["Chibi-Robo!", 2005], ["Pokémon XD: Gale of Darkness", 2005], ["Skies of Arcadia Legends", 2002],
  ["Cubivore: Survival of the Fittest", 2002], ["Baten Kaitos: Eternal Wings and the Lost Ocean", 2003], ["Fire Emblem: Path of Radiance", 2005],
  // PS2
  ["Rule of Rose", 2006], ["Haunting Ground", 2005], ["Kuon", 2004], ["Shadow Hearts: From the New World", 2005], ["Steambot Chronicles", 2005],
  // Portables
  ["Kid Dracula", 1993], ["Mega Man V", 1994], ["Shantae", 2002], ["Ninja Five-O", 2003], ["Kirby Tilt 'n' Tumble", 2000],
  ["Jack Bros.", 1995], ["Virtual Boy Wario Land", 1995], ["Mother 3", 2006],
  // Jaguar
  ["Alien vs Predator", 1994], ["Tempest 2000", 1994],
];

async function igdbAt(env, endpoint, query, retried = false) {
  const token = await getToken(env);
  const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: "POST",
    headers: { "Client-ID": env.CLIENT_ID.trim(), Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: query,
  });
  if (res.status === 401 && !retried) { cachedToken = null; tokenExpiry = 0; return igdbAt(env, endpoint, query, true); }
  if (!res.ok) throw new Error(`Erreur IGDB (${res.status}) : ${await res.text()}`);
  return res.json();
}

// Petit cache JSON (API Cache de Cloudflare) pour éviter de refaire les mêmes requêtes
async function cacheJson(ctx, key, ttl, compute) {
  const req = new Request("https://cache.cartridge/" + encodeURIComponent(key));
  const hit = await cacheGet(req);
  if (hit) { try { return await hit.json(); } catch (e) {} }
  const value = await compute();
  if (value != null) {
    cachePut(ctx, req, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } }));
  }
  return value;
}

function rollRarity(odds) {
  let r = Math.random() * 100;
  for (const k of ["legendary", "epic", "rare", "common"]) {
    if ((r -= odds[k] || 0) < 0) return k;
  }
  return Object.keys(odds).find((k) => odds[k] > 0) || "common";
}

// Un grail au hasard (le jeu IGDB correspondant est gardé 30 jours en cache)
async function drawGrail(env, ctx, exclude) {
  const order = [...GRAILS].sort(() => Math.random() - 0.5);
  for (const [name, year] of order.slice(0, 6)) {
    const g = await cacheJson(ctx, "grail:v1:" + name, 30 * DAY, async () => {
      const safe = name.replace(/["\;]/g, "");
      const list = await igdbAt(env, "games", `search "${safe}"; ${DETAIL_FIELDS} where cover != null; limit 15;`);
      const yearOf = (x) => (x.first_release_date ? new Date(x.first_release_date * 1000).getUTCFullYear() : 0);
      const near = (x) => Math.abs(yearOf(x) - year) <= 3;
      const best = list.find((x) => normName(x.name) === normName(name) && near(x))
        || list.find((x) => normName(x.name) === normName(name))
        || list.find((x) => near(x) && normName(x.name).includes(normName(name).slice(0, 8)));
      return best || null;
    });
    if (g && !exclude.has(g.id)) return g;
  }
  return null;
}

// Un jeu au hasard dans un réservoir (nombre total mis en cache 1 jour, puis position au hasard)
async function drawFromPool(env, ctx, rarity, exclude) {
  const where = poolWhere(rarity);
  const total = await cacheJson(ctx, "poolcount:v1:" + rarity, DAY, async () => {
    const r = await igdbAt(env, "games/count", `where ${where};`);
    return r && typeof r.count === "number" ? r.count : null;
  });
  if (!total) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const offset = Math.floor(Math.random() * Math.max(1, total - 50));
    let list;
    try {
      list = await igdbAt(env, "games", `${DETAIL_FIELDS} where ${where}; sort id asc; limit 50; offset ${offset};`);
    } catch (e) {
      // certaines positions trop lointaines peuvent être refusées : on reprend depuis le début
      list = await igdbAt(env, "games", `${DETAIL_FIELDS} where ${where}; sort id asc; limit 200;`);
    }
    const fresh = (list || []).filter((g) => !exclude.has(g.id));
    if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
  }
  return null;
}

async function drawPack(url, env, ctx) {
  const pack = PACK_ODDS[url.searchParams.get("pack")] ? url.searchParams.get("pack") : "standard";
  const exclude = new Set(
    String(url.searchParams.get("exclude") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 600)
  );
  const noStore = { ...CORS, "Cache-Control": "no-store" };
  try {
    let rarity = rollRarity(PACK_ODDS[pack]);
    let raw = null;
    // Si une rareté ne donne rien (tout déjà possédé, panne…), on descend d'un cran
    const chain = ["legendary", "epic", "rare", "common"];
    for (let i = chain.indexOf(rarity); i < chain.length && !raw; i++) {
      rarity = chain[i];
      if (pack !== "standard" && rarity === "common") rarity = "rare"; // un booster rétro ne donne jamais de jeu récent
      raw = rarity === "legendary" ? await drawGrail(env, ctx, exclude) : await drawFromPool(env, ctx, rarity, exclude);
    }
    if (!raw) return Response.json({ error: "Aucun jeu disponible" }, { status: 404, headers: noStore });
    const [game] = buildGames([raw], { allowedIds: null, searchMode: true });
    const out = game || {
      id: raw.id, name: raw.name, summary: raw.summary || null, genres: [], releases: [], date: null,
      cover: raw.cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${raw.cover.image_id}.jpg` : "",
    };
    out.rarity = rarity;
    out.rarityLabel = RARITY_LABEL[rarity];
    out.pack = pack;
    return Response.json(out, { headers: noStore });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: noStore });
  }
}

// =====================================================================
//  COMPTES JOUEURS (base D1, binding « DB ») : /api/auth, /api/save, /api/recover
// =====================================================================
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
// Le Worker n'accepte pas plus de 100 000 tours. 50 000 reste léger pour le plan gratuit ;
// si Cloudflare affiche « exceeded CPU » à la connexion, passe à 25 000 (ou au plan payant et 100 000).
const PBKDF2_ITERATIONS = 50000;
const MAX_DATA_BYTES = 100000;
const enc = new TextEncoder();
const jsonRes = (obj, status = 200) => Response.json(obj, { status, headers: CORS });
const nowSec = () => Math.floor(Date.now() / 1000);

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
async function sha256Hex(str) { return toHex(await crypto.subtle.digest("SHA-256", enc.encode(str))); }

async function pbkdf2(secret, saltBytes, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations }, key, 256));
}
async function makeHash(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await pbkdf2(secret, salt, PBKDF2_ITERATIONS), salt: b64(salt), iters: PBKDF2_ITERATIONS };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function checkHash(secret, hash, salt, iters) {
  return safeEqual(await pbkdf2(secret, unb64(salt), iters || PBKDF2_ITERATIONS), hash);
}

// Données de sauvegarde : on ne garde que les champs attendus, avec leur type
function cleanData(d) {
  const out = {};
  if (d && typeof d === "object") {
    if (Number.isFinite(d.userCoins) && d.userCoins >= 0) out.userCoins = Math.floor(d.userCoins);
    if (Array.isArray(d.myCollection)) out.myCollection = d.myCollection;
    if (Array.isArray(d.favorites)) out.favorites = d.favorites.filter((x) => Number.isInteger(x));
    if (Array.isArray(d.gameScores)) out.gameScores = d.gameScores;
    if (typeof d.theme === "string") out.theme = d.theme.slice(0, 30);
    // Achats de la Boutique (thèmes collector, avatars, bannières) : listes de petits identifiants
    if (d.unlocks && typeof d.unlocks === "object") {
      const ids = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string" && /^[a-z0-9_-]{1,40}$/i.test(x)).slice(0, 100) : []);
      const one = (x) => (typeof x === "string" && /^[a-z0-9_-]{0,40}$/i.test(x) ? x : "");
      out.unlocks = {
        themes: ids(d.unlocks.themes),
        avatars: ids(d.unlocks.avatars),
        banners: ids(d.unlocks.banners),
        avatar: one(d.unlocks.avatar),
        banner: one(d.unlocks.banner),
        uniqueTheme: one(d.unlocks.uniqueTheme),
        // sets de boutons de la Boutique (avant, ils étaient effacés à chaque sauvegarde)
        buttons: ids(d.unlocks.buttons),
        buttonSkin: one(d.unlocks.buttonSkin),
      };
    }
    // Gains de l'Arcade : succès, statistiques, missions/quiz/machine du jour
    if (d.rewards && typeof d.rewards === "object" && !Array.isArray(d.rewards)) {
      const r = d.rewards;
      const num = (x) => (Number.isFinite(+x) && +x >= 0 ? Math.floor(+x) : 0);
      const nums = (o) => { const out = {}; if (o && typeof o === "object") for (const [k, v] of Object.entries(o).slice(0, 20)) if (/^[a-z0-9_-]{1,20}$/i.test(k)) out[k] = num(v); return out; };
      const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string" && /^[a-z0-9_-]{1,20}$/i.test(x)).slice(0, 20) : []);
      const ach = {};
      if (r.ach && typeof r.ach === "object") for (const [k, v] of Object.entries(r.ach).slice(0, 50)) if (/^[a-z0-9_-]{1,20}$/i.test(k)) ach[k] = String(v).slice(0, 10);
      const st = r.stats && typeof r.stats === "object" ? r.stats : {};
      out.rewards = {
        day: typeof r.day === "string" ? r.day.slice(0, 10) : "",
        arcadeCoins: num(r.arcadeCoins), gamesToday: num(r.gamesToday),
        gamesSet: strs(r.gamesSet), missionsDone: strs(r.missionsDone),
        slot: r.slot && typeof r.slot === "object" ? { reels: strs(r.slot.reels).slice(0, 3), win: num(r.slot.win) } : null,
        quiz: { answers: Array.isArray(r.quiz && r.quiz.answers) ? r.quiz.answers.slice(0, 3).map((a) => (Number.isInteger(a) && a >= 0 && a < 4 ? a : null)) : [null, null, null] },
        ach,
        stats: { games: num(st.games), quizGood: num(st.quizGood), played: nums(st.played), best: nums(st.best), max: nums(st.max), wins: nums(st.wins), pongExpert: !!st.pongExpert, jackpot: !!st.jackpot },
      };
    }
    // Chasse aux secrets (2 séries d'easter eggs) : { found: { id: "AAAA-MM-JJ" }, badge, badge2 }
    if (d.eggs && typeof d.eggs === "object" && !Array.isArray(d.eggs)) {
      const found = {};
      if (d.eggs.found && typeof d.eggs.found === "object") for (const [k, v] of Object.entries(d.eggs.found).slice(0, 60)) if (/^[a-z0-9_-]{1,20}$/i.test(k)) found[k] = String(v).slice(0, 10);
      out.eggs = { found, badge: typeof d.eggs.badge === "string" ? d.eggs.badge.slice(0, 10) : "", badge2: typeof d.eggs.badge2 === "string" ? d.eggs.badge2.slice(0, 10) : "" };
    }
  }
  return JSON.stringify(out).length <= MAX_DATA_BYTES ? out : null;
}

// Durée de vie d'une connexion : 90 jours, puis il faut se reconnecter
const SESSION_MAX_AGE = 90 * 24 * 3600;
// Créations de comptes : 3 maximum par connexion internet sur 24 heures
const MAX_SIGNUPS_PER_IP = 3;
const SIGNUP_WINDOW = 24 * 3600;

// Protection contre les essais en série (fenêtre de 15 minutes par défaut)
async function tooManyAttempts(env, limits) {
  for (const { key, max, window = 900 } of limits) {
    const row = await env.DB.prepare("SELECT n, ts FROM attempts WHERE key = ?").bind(key).first();
    if (row && nowSec() - row.ts < window && row.n >= max) return true;
  }
  return false;
}
async function noteFailure(env, limits) {
  const t = nowSec();
  for (const { key, window = 900 } of limits) {
    await env.DB.prepare(
      "INSERT INTO attempts (key, n, ts) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = CASE WHEN ? - ts >= ? THEN 1 ELSE n + 1 END, ts = CASE WHEN ? - ts >= ? THEN ? ELSE ts END"
    ).bind(key, t, t, window, t, window, t).run();
  }
}
async function clearFailures(env, key) {
  await env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(key).run();
}

// Crée une session (jeton aléatoire ; seul son empreinte est gardée), 5 appareils maximum
async function newSession(env, userId) {
  const token = randomToken();
  // Ménage : on efface les connexions de plus de 90 jours (tous joueurs confondus)
  await env.DB.prepare("DELETE FROM sessions WHERE created_at < ?").bind(nowSec() - SESSION_MAX_AGE).run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), userId, nowSec()).run();
  await env.DB.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)"
  ).bind(userId, userId).run();
  return token;
}

async function handleAuth(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonRes({ error: "Requête invalide." }, 400); }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const recovery = String(body.recoveryQ || "").trim().toLowerCase().slice(0, 100);
  if (!USERNAME_RE.test(username)) return jsonRes({ error: "Pseudo invalide : 3 à 20 caractères (lettres, chiffres, _ ou -)." }, 400);
  if (password.length < 8 || password.length > 100) return jsonRes({ error: "Le mot de passe doit faire entre 8 et 100 caractères." }, 400);

  const nameLower = username.toLowerCase();
  const ip = request.headers.get("CF-Connecting-IP") || "inconnu";
  const limits = [{ key: "u:" + nameLower, max: 8 }, { key: "ip:" + ip, max: 30 }];
  if (await tooManyAttempts(env, limits)) return jsonRes({ error: "Trop d'essais. Réessaie dans 15 minutes." }, 429);

  // mode : "register" (créer un compte) ou "login" (se connecter).
  // Sans mode, ancien comportement (un seul bouton) pour ne pas casser l'app actuelle.
  const mode = body.mode === "register" || body.mode === "login" ? body.mode : "auto";

  const user = await env.DB.prepare("SELECT * FROM users WHERE name_lower = ?").bind(nameLower).first();

  if (user && mode === "register") {
    return jsonRes({ error: "Ce pseudo est déjà pris. Choisis-en un autre, ou connecte-toi." }, 409);
  }
  if (!user && mode === "login") {
    // Même message qu'un mauvais mot de passe : on ne révèle pas si le pseudo existe
    await noteFailure(env, limits);
    return jsonRes({ error: "Pseudo ou mot de passe incorrect." }, 401);
  }

  if (!user) {
    // ----- Création du compte -----
    const signupLimit = [{ key: "c:" + ip, max: MAX_SIGNUPS_PER_IP, window: SIGNUP_WINDOW }];
    if (await tooManyAttempts(env, signupLimit)) {
      return jsonRes({ error: "Trop de comptes créés depuis cette connexion. Réessaie demain." }, 429);
    }
    const data = cleanData(body.data);
    if (data === null) return jsonRes({ error: "Sauvegarde trop volumineuse." }, 400);
    const p = await makeHash(password);
    const r = recovery ? await makeHash(recovery) : { hash: null, salt: null, iters: null };
    const t = nowSec();
    let id;
    try {
      const res = await env.DB.prepare(
        "INSERT INTO users (name_lower, display_name, pass_hash, pass_salt, pass_iters, recovery_hash, recovery_salt, recovery_iters, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(nameLower, username, p.hash, p.salt, p.iters, r.hash, r.salt, r.iters, JSON.stringify(data), t, t).run();
      id = res.meta && res.meta.last_row_id;
    } catch (e) {
      return jsonRes({ error: "Ce pseudo vient d'être pris. Réessaie." }, 409);
    }
    await noteFailure(env, signupLimit); // compte une création pour cette connexion internet
    return jsonRes({ status: "created", token: await newSession(env, id), username });
  }

  // ----- Connexion -----
  const ok = await checkHash(password, user.pass_hash, user.pass_salt, user.pass_iters);
  if (!ok) {
    await noteFailure(env, limits);
    return jsonRes({ error: "Pseudo ou mot de passe incorrect." }, 401);
  }
  await clearFailures(env, limits[0].key);
  let saved = {};
  try { saved = JSON.parse(user.data || "{}"); } catch (e) {}
  return jsonRes({ status: "connected", token: await newSession(env, user.id), username: user.display_name, data: saved });
}

async function handleSave(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return jsonRes({ error: "Non connecté." }, 401);
  const tokenHash = await sha256Hex(token);
  const sess = await env.DB.prepare("SELECT user_id, created_at FROM sessions WHERE token_hash = ?").bind(tokenHash).first();
  if (!sess) return jsonRes({ error: "Session expirée. Reconnecte-toi." }, 401);
  if (nowSec() - sess.created_at > SESSION_MAX_AGE) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return jsonRes({ error: "Session expirée. Reconnecte-toi." }, 401);
  }
  let body;
  try { body = await request.json(); } catch (e) { return jsonRes({ error: "Requête invalide." }, 400); }
  const data = cleanData(body.data);
  if (data === null) return jsonRes({ error: "Sauvegarde trop volumineuse." }, 400);
  await env.DB.prepare("UPDATE users SET data = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(data), nowSec(), sess.user_id).run();
  return jsonRes({ status: "saved" });
}

async function handleRecover(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonRes({ error: "Requête invalide." }, 400); }
  const nameLower = String(body.username || "").trim().toLowerCase();
  const answer = String(body.answer || "").trim().toLowerCase().slice(0, 100);
  const newPassword = String(body.newPassword || "");
  if (!USERNAME_RE.test(nameLower) || !answer) return jsonRes({ error: "Remplis le pseudo et la réponse secrète." }, 400);
  if (newPassword.length < 8 || newPassword.length > 100) return jsonRes({ error: "Le nouveau mot de passe doit faire entre 8 et 100 caractères." }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "inconnu";
  const limits = [{ key: "r:" + nameLower, max: 5 }, { key: "rip:" + ip, max: 20 }];
  if (await tooManyAttempts(env, limits)) return jsonRes({ error: "Trop d'essais. Réessaie dans 15 minutes." }, 429);

  const user = await env.DB.prepare("SELECT * FROM users WHERE name_lower = ?").bind(nameLower).first();
  const generic = "Récupération impossible avec ces informations.";
  if (!user || !user.recovery_hash) { await noteFailure(env, limits); return jsonRes({ error: generic }, 401); }
  if (!(await checkHash(answer, user.recovery_hash, user.recovery_salt, user.recovery_iters))) {
    await noteFailure(env, limits);
    return jsonRes({ error: generic }, 401);
  }
  const p = await makeHash(newPassword);
  await env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iters = ?, updated_at = ? WHERE id = ?")
    .bind(p.hash, p.salt, p.iters, nowSec(), user.id).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run(); // déconnecte tous les appareils
  await clearFailures(env, limits[0].key);
  return jsonRes({ status: "reset" });
}


// =====================================================================
// MESSAGERIE — salon commun + conversations privées entre joueurs
//   Routes (POST, en-tête « Authorization: Bearer <jeton> ») :
//     /api/msg/sync     { since, here }      → nouveaux messages depuis l'id « since »
//     /api/msg/convs    {}                   → liste des conversations (non lus, en ligne)
//     /api/msg/history  { conv, before }     → 40 messages plus anciens
//     /api/msg/open     { to: "pseudo" }     → ouvre (ou retrouve) une conversation privée
//     /api/msg/send     { conv, body }       → envoie un message (500 caractères max)
//     /api/msg/read     { conv, upto }       → marque comme lu
//     /api/msg/block    { user, on }         → bloque / débloque un joueur
//     /api/msg/delete   { id }               → efface un de ses messages (ou n'importe lequel pour l'admin)
//   Variable facultative MSG_ADMIN = ton pseudo (pour pouvoir effacer n'importe quel message du salon).
//   Les tables sont créées toutes seules au premier appel. Le salon commun a toujours l'id 1.
// =====================================================================
const MSG_MAX_LEN = 500;
const MSG_ONLINE = 75;           // « en ligne » = vu il y a moins de 75 s
const MSG_RATE = { max: 12, window: 60 }; // 12 messages par minute maximum
let msgReady = false;

async function ensureMsgTables(env) {
  if (msgReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS msg_convs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, last_id INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0, UNIQUE(a, b))"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS msg_convs_b ON msg_convs(b)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv_id, id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS msg_reads (conv_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read INTEGER NOT NULL, PRIMARY KEY (conv_id, user_id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS msg_blocks (user_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, PRIMARY KEY (user_id, blocked_id))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS msg_presence (user_id INTEGER PRIMARY KEY, seen INTEGER NOT NULL)"),
    env.DB.prepare("INSERT OR IGNORE INTO msg_convs (id, kind, a, b) VALUES (1, 'room', 0, 0)"),
  ]);
  msgReady = true;
}

// Joueur connecté (d'après le jeton), ou null
async function sessionUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    "SELECT s.user_id AS id, s.created_at, u.display_name AS name, u.name_lower FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(await sha256Hex(token)).first();
  if (!row || nowSec() - row.created_at > SESSION_MAX_AGE) return null;
  return row;
}

async function msgConv(env, convId, uid) {
  if (!Number.isInteger(convId) || convId < 1) return null;
  return env.DB.prepare("SELECT * FROM msg_convs WHERE id = ? AND (id = 1 OR a = ? OR b = ?)").bind(convId, uid, uid).first();
}

// av = avatar pixel choisi dans la Boutique (lu dans la sauvegarde du joueur)
const MSG_AV = (t) => `CASE WHEN json_valid(${t}.data) THEN json_extract(${t}.data, '$.unlocks.avatar') END`;
const MSG_COLS = `m.id, m.conv_id AS conv, m.user_id AS uid, u.display_name AS name, ${MSG_AV("u")} AS av, m.body, m.created_at AS at`;

async function handleMsg(action, request, env) {
  await ensureMsgTables(env);
  const me = await sessionUser(request, env);
  if (!me) return jsonRes({ error: "Connecte-toi pour utiliser la messagerie." }, 401);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const t = nowSec();
  const isAdmin = !!env.MSG_ADMIN && String(env.MSG_ADMIN).toLowerCase() === me.name_lower;

  if (action === "sync") {
    if (body.here) await env.DB.prepare("INSERT INTO msg_presence (user_id, seen) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET seen = excluded.seen").bind(me.id, t).run();
    // since < 0 (ou absent) = première synchro : on renvoie juste le dernier numéro de message
    const raw = Number(body.since);
    if (!Number.isFinite(raw) || raw < 0) {
      const last = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages").first();
      return jsonRes({ me: { id: me.id, name: me.name, admin: isAdmin }, messages: [], last: last.id });
    }
    const since = Math.floor(raw);
    const { results } = await env.DB.prepare(
      `SELECT ${MSG_COLS} FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.id > ?1 AND (m.conv_id = 1 OR m.conv_id IN (SELECT id FROM msg_convs WHERE a = ?2 OR b = ?2))
         AND m.user_id NOT IN (SELECT blocked_id FROM msg_blocks WHERE user_id = ?2)
       ORDER BY m.id LIMIT 100`
    ).bind(since, me.id).all();
    const last = results.length ? results[results.length - 1].id : since;
    return jsonRes({ me: { id: me.id, name: me.name, admin: isAdmin }, messages: results, last });
  }

  if (action === "convs") {
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.kind, c.last_id, c.last_at,
              o.id AS other_id, o.display_name AS other, ${MSG_AV("o")} AS other_av,
              p.seen AS other_seen,
              lm.body AS last_body, lm.user_id AS last_uid,
              (SELECT COUNT(*) FROM (SELECT 1 FROM messages m WHERE m.conv_id = c.id AND m.id > COALESCE(r.last_read, 0) AND m.user_id != ?1
                 AND m.user_id NOT IN (SELECT blocked_id FROM msg_blocks WHERE user_id = ?1) LIMIT 99)) AS unread
       FROM msg_convs c
       LEFT JOIN msg_reads r ON r.conv_id = c.id AND r.user_id = ?1
       LEFT JOIN users o ON o.id = CASE WHEN c.a = ?1 THEN c.b ELSE c.a END AND c.kind = 'dm'
       LEFT JOIN msg_presence p ON p.user_id = o.id
       LEFT JOIN messages lm ON lm.id = c.last_id
       WHERE c.id = 1 OR c.a = ?1 OR c.b = ?1
       ORDER BY (c.id = 1) DESC, c.last_at DESC LIMIT 60`
    ).bind(me.id).all();
    const blocks = await env.DB.prepare("SELECT blocked_id FROM msg_blocks WHERE user_id = ?").bind(me.id).all();
    const online = await env.DB.prepare("SELECT COUNT(*) AS n FROM msg_presence WHERE seen > ?").bind(t - MSG_ONLINE).first();
    return jsonRes({
      me: { id: me.id, name: me.name, admin: isAdmin },
      online: online.n,
      blocked: blocks.results.map((b) => b.blocked_id),
      convs: results.map((c) => ({
        id: c.id, kind: c.kind, last_at: c.last_at, unread: c.unread,
        other: c.other || null, other_id: c.other_id || null, other_av: c.other_av || "",
        online: !!(c.other_seen && t - c.other_seen < MSG_ONLINE),
        last: c.last_body ? { body: String(c.last_body).slice(0, 80), mine: c.last_uid === me.id } : null,
      })),
    });
  }

  // Annuaire des joueurs : en ligne d'abord, puis les derniers venus (pour se retrouver sans taper le pseudo exact)
  if (action === "players") {
    const q = String(body.q || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.display_name AS name, ${MSG_AV("u")} AS av, p.seen
       FROM users u LEFT JOIN msg_presence p ON p.user_id = u.id
       WHERE u.id != ?1 AND u.id NOT IN (SELECT blocked_id FROM msg_blocks WHERE user_id = ?1)
         AND (?2 = '' OR u.name_lower LIKE ?2)
       ORDER BY COALESCE(p.seen, 0) DESC, u.updated_at DESC LIMIT 60`
    ).bind(me.id, q ? "%" + q + "%" : "").all();
    return jsonRes({ players: results.map((u) => ({ id: u.id, name: u.name, av: u.av || "", seen: u.seen || 0, online: !!(u.seen && t - u.seen < MSG_ONLINE) })), now: t });
  }

  if (action === "history") {
    const conv = await msgConv(env, Number(body.conv), me.id);
    if (!conv) return jsonRes({ error: "Conversation introuvable." }, 404);
    const before = Math.floor(Number(body.before) || 0) || 2147483647;
    const { results } = await env.DB.prepare(
      `SELECT ${MSG_COLS} FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.conv_id = ? AND m.id < ? AND m.user_id NOT IN (SELECT blocked_id FROM msg_blocks WHERE user_id = ?)
       ORDER BY m.id DESC LIMIT 40`
    ).bind(conv.id, before, me.id).all();
    return jsonRes({ messages: results.reverse(), more: results.length === 40 });
  }

  if (action === "open") {
    const to = String(body.to || "").trim().toLowerCase();
    if (!USERNAME_RE.test(to)) return jsonRes({ error: "Pseudo invalide." }, 400);
    const other = await env.DB.prepare("SELECT id, display_name FROM users WHERE name_lower = ?").bind(to).first();
    if (!other) return jsonRes({ error: "Aucun joueur avec ce pseudo." }, 404);
    if (other.id === me.id) return jsonRes({ error: "Tu ne peux pas t'écrire à toi-même 🙂" }, 400);
    const a = Math.min(me.id, other.id), b = Math.max(me.id, other.id);
    await env.DB.prepare("INSERT OR IGNORE INTO msg_convs (kind, a, b, last_at) VALUES ('dm', ?, ?, ?)").bind(a, b, t).run();
    const conv = await env.DB.prepare("SELECT id FROM msg_convs WHERE a = ? AND b = ?").bind(a, b).first();
    return jsonRes({ conv: conv.id, other: other.display_name, other_id: other.id });
  }

  if (action === "send") {
    const conv = await msgConv(env, Number(body.conv), me.id);
    if (!conv) return jsonRes({ error: "Conversation introuvable." }, 404);
    const text = String(body.body || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, MSG_MAX_LEN);
    if (!text) return jsonRes({ error: "Message vide." }, 400);
    const rate = [{ key: "msg:" + me.id, max: MSG_RATE.max, window: MSG_RATE.window }];
    if (await tooManyAttempts(env, rate)) return jsonRes({ error: "Doucement ! Attends quelques secondes avant d'écrire encore." }, 429);
    if (conv.kind === "dm") {
      const other = conv.a === me.id ? conv.b : conv.a;
      const blocked = await env.DB.prepare("SELECT 1 FROM msg_blocks WHERE user_id = ? AND blocked_id = ?").bind(other, me.id).first();
      if (blocked) return jsonRes({ error: "Ce joueur ne reçoit pas tes messages." }, 403);
    }
    const res = await env.DB.prepare("INSERT INTO messages (conv_id, user_id, body, created_at) VALUES (?, ?, ?, ?)").bind(conv.id, me.id, text, t).run();
    const id = res.meta && res.meta.last_row_id;
    await env.DB.batch([
      env.DB.prepare("UPDATE msg_convs SET last_id = ?, last_at = ? WHERE id = ?").bind(id, t, conv.id),
      env.DB.prepare("INSERT INTO msg_reads (conv_id, user_id, last_read) VALUES (?, ?, ?) ON CONFLICT(conv_id, user_id) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)").bind(conv.id, me.id, id),
      env.DB.prepare("INSERT INTO msg_presence (user_id, seen) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET seen = excluded.seen").bind(me.id, t),
    ]);
    await noteFailure(env, rate); // compte le message pour la limite « 12 par minute »
    return jsonRes({ message: { id, conv: conv.id, uid: me.id, name: me.name, av: "", body: text, at: t } });
  }

  if (action === "read") {
    const conv = await msgConv(env, Number(body.conv), me.id);
    if (!conv) return jsonRes({ error: "Conversation introuvable." }, 404);
    const upto = Math.max(0, Math.floor(Number(body.upto) || 0));
    await env.DB.prepare("INSERT INTO msg_reads (conv_id, user_id, last_read) VALUES (?, ?, ?) ON CONFLICT(conv_id, user_id) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)").bind(conv.id, me.id, upto).run();
    return jsonRes({ status: "ok" });
  }

  if (action === "block") {
    const uid = Math.floor(Number(body.user) || 0);
    if (!uid || uid === me.id) return jsonRes({ error: "Joueur invalide." }, 400);
    if (body.on) await env.DB.prepare("INSERT OR IGNORE INTO msg_blocks (user_id, blocked_id) VALUES (?, ?)").bind(me.id, uid).run();
    else await env.DB.prepare("DELETE FROM msg_blocks WHERE user_id = ? AND blocked_id = ?").bind(me.id, uid).run();
    return jsonRes({ status: body.on ? "blocked" : "unblocked" });
  }

  if (action === "delete") {
    const id = Math.floor(Number(body.id) || 0);
    const m = await env.DB.prepare("SELECT id, user_id, conv_id FROM messages WHERE id = ?").bind(id).first();
    if (!m || (m.user_id !== me.id && !isAdmin)) return jsonRes({ error: "Tu ne peux pas effacer ce message." }, 403);
    await env.DB.prepare("UPDATE messages SET body = '' WHERE id = ?").bind(id).run();
    return jsonRes({ status: "deleted" });
  }

  return jsonRes({ error: "Adresse inconnue." }, 404);
}

async function handleApi(path, request, env) {
  // Vérification rapide dans un navigateur : ouvre https://<ton-worker>/api/msg/ping
  if (path === "/api/msg/ping") {
    if (!env.DB) return jsonRes({ ok: false, error: "binding DB manquant" }, 500);
    try { await ensureMsgTables(env); const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first(); return jsonRes({ ok: true, messagerie: "prête", messages: n.n }); }
    catch (e) { return jsonRes({ ok: false, error: String(e && e.message || e).slice(0, 200) }, 500); }
  }
  if (request.method !== "POST") return jsonRes({ error: "Méthode non autorisée." }, 405);
  if (!env.DB) return jsonRes({ error: "Base de données non reliée au Worker (binding DB manquant)." }, 500);
  try {
    if (path === "/api/auth") return await handleAuth(request, env);
    if (path === "/api/save") return await handleSave(request, env);
    if (path === "/api/recover") return await handleRecover(request, env);
    if (path.startsWith("/api/msg/")) return await handleMsg(path.slice(9), request, env);
    return jsonRes({ error: "Adresse inconnue." }, 404);
  } catch (e) {
    return jsonRes({ error: "Erreur du serveur.", debug: e && e.message ? String(e.message).slice(0, 200) : "" }, 500);
  }
}

// =====================================================================
// ESPORT (PandaScore, plan gratuit « Fixtures ») — route ?esport=running|upcoming|past&game=all|lol|cs2|valorant|dota2|rl
//   Secret à ajouter dans Cloudflare : PANDASCORE_TOKEN (Settings → Variables and Secrets)
//   Les réponses sont gardées en cache (1 min pour le direct, 10 min sinon) :
//   on reste très loin de la limite de 1000 requêtes par heure.
// =====================================================================
const ESPORT_GAMES = { all: "", lol: "lol", cs2: "csgo", valorant: "valorant", dota2: "dota2", rl: "rl" };
const ESPORT_TTL = { running: 60, upcoming: 600, past: 600 };

async function getEsport(url, env, ctx) {
  if (!env.PANDASCORE_TOKEN) return jsonRes({ error: "pas de clé PANDASCORE_TOKEN" }, 503);
  const kind = ESPORT_TTL[url.searchParams.get("esport")] ? url.searchParams.get("esport") : "upcoming";
  const gameParam = url.searchParams.get("game") || "all";
  const game = Object.prototype.hasOwnProperty.call(ESPORT_GAMES, gameParam) ? gameParam : "all";

  const cacheKey = new Request(`${url.origin}/esport-v1/${kind}/${game}`);
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const path = (ESPORT_GAMES[game] ? `/${ESPORT_GAMES[game]}` : "") + `/matches/${kind}`;
  const qs = new URLSearchParams({ per_page: "60", sort: kind === "past" ? "-begin_at" : "begin_at" });
  let list;
  try {
    const res = await fetch(`https://api.pandascore.co${path}?${qs}`, {
      headers: { Authorization: `Bearer ${env.PANDASCORE_TOKEN.trim()}`, Accept: "application/json" },
    });
    if (!res.ok) return jsonRes({ error: `PandaScore a répondu ${res.status}` }, 502);
    list = await res.json();
  } catch (e) {
    return jsonRes({ error: "PandaScore injoignable" }, 502);
  }
  if (!Array.isArray(list)) list = [];

  // On ne renvoie que ce dont l'app a besoin (réponse ~10 fois plus légère)
  const matches = list.map((m) => {
    const results = Array.isArray(m.results) ? m.results : [];
    const streams = Array.isArray(m.streams_list) ? m.streams_list : [];
    const stream = streams.find((x) => x.language === "fr") || streams.find((x) => x.main) || streams[0];
    return {
      id: m.id,
      status: m.status, // not_started · running · finished · canceled · postponed
      begin: m.begin_at || m.scheduled_at || null,
      bo: m.number_of_games || null,
      game: m.videogame ? m.videogame.name : "",
      gameSlug: m.videogame ? m.videogame.slug : "",
      league: m.league ? m.league.name : "",
      leagueImg: m.league ? m.league.image_url : null,
      serie: m.serie ? (m.serie.full_name || m.serie.name || "") : "",
      stage: m.tournament ? m.tournament.name : "",
      winner: m.winner_id || null,
      stream: stream ? stream.raw_url : null,
      teams: (Array.isArray(m.opponents) ? m.opponents : []).slice(0, 2).map((o) => {
        const t = o.opponent || {};
        const r = results.find((x) => x.team_id === t.id || x.player_id === t.id);
        return { id: t.id, name: t.name || "?", acr: t.acronym || "", img: t.image_url || null, score: r ? r.score : null };
      }),
    };
  });

  const response = Response.json(matches, {
    headers: { ...CORS, "Cache-Control": `public, max-age=${ESPORT_TTL[kind]}` },
  });
  cachePut(ctx, cacheKey, response.clone());
  return response;
}

// =====================================================================
// ANIME & MANGA (AniList, gratuit, sans clé) — route ?anime=schedule|manga
//   schedule : épisodes qui sortent sur 7 jours (heure de diffusion au Japon)
//   manga    : mangas en cours les plus suivis en ce moment
//   Cache 30 min : AniList limite à ~30 requêtes/minute sans compte.
// =====================================================================
const ANILIST_URL = "https://graphql.anilist.co";

async function anilist(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    // AniList (derrière Cloudflare) refuse souvent les requêtes sans « User-Agent »
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Cartridge/1.0 (app perso, calendrier jeux)" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.errors) throw new Error((data && data.errors && data.errors[0] && data.errors[0].message) || `AniList ${res.status}`);
  return data.data;
}

const AL_MEDIA_FIELDS = `id title { romaji english } coverImage { large color } siteUrl isAdult format popularity episodes chapters genres countryOfOrigin status
  externalLinks { site url type }`;

function alShort(m) {
  const streams = (m.externalLinks || []).filter((l) => l.type === "STREAMING" && l.url);
  const fr = streams.find((l) => /crunchyroll|adn|animation digital|netflix|disney|prime|wakanim/i.test(l.site));
  return {
    id: m.id,
    title: (m.title && (m.title.english || m.title.romaji)) || "?",
    cover: m.coverImage ? m.coverImage.large : null,
    color: m.coverImage ? m.coverImage.color : null,
    url: m.siteUrl,
    format: m.format,
    episodes: m.episodes || null,
    chapters: m.chapters || null,
    genres: (m.genres || []).slice(0, 3),
    stream: (fr || streams[0]) ? { site: (fr || streams[0]).site, url: (fr || streams[0]).url } : null,
  };
}

async function getAnime(url, ctx) {
  const kind = url.searchParams.get("anime") === "manga" ? "manga" : "schedule";
  const hour = Math.floor(Date.now() / 3600e3);
  const cacheKey = new Request(`${url.origin}/anime-v1/${kind}/${kind === "schedule" ? Math.floor(hour / 1) : Math.floor(hour / 6)}`);
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  let out = [];
  try {
    if (kind === "schedule") {
      const start = hour * 3600 - 6 * 3600, end = start + 7 * 86400 + 6 * 3600;
      const q = `query ($s: Int, $e: Int, $p: Int) { Page(page: $p, perPage: 25) { pageInfo { hasNextPage }
        airingSchedules(airingAt_greater: $s, airingAt_lesser: $e, sort: TIME) { episode airingAt media { ${AL_MEDIA_FIELDS} } } } }`;
      for (let p = 1; p <= 8; p++) {
        let d;
        try { d = await anilist(q, { s: start, e: end, p }); }
        catch (err) { if (p === 1) throw err; break; } // on garde ce qui a déjà été reçu
        const list = (d.Page && d.Page.airingSchedules) || [];
        list.forEach((a) => {
          const m = a.media;
          // séries japonaises connues, tout public (on écarte les très confidentielles)
          if (!m || m.isAdult || m.countryOfOrigin !== "JP" || (m.popularity || 0) < 3000) return;
          if (!["TV", "TV_SHORT", "ONA"].includes(m.format)) return;
          out.push({ ...alShort(m), episode: a.episode, at: a.airingAt, popularity: m.popularity });
        });
        if (!d.Page.pageInfo.hasNextPage) break;
      }
    } else {
      const q = `query { Page(page: 1, perPage: 24) { media(type: MANGA, status: RELEASING, isAdult: false, sort: TRENDING_DESC) { ${AL_MEDIA_FIELDS} } } }`;
      const d = await anilist(q, {});
      out = ((d.Page && d.Page.media) || []).map(alShort);
    }
  } catch (e) {
    return jsonRes({ error: "AniList injoignable : " + e.message }, 502);
  }
  const response = Response.json(out, { headers: { ...CORS, "Cache-Control": out.length ? "public, max-age=1800" : "no-store" } });
  if (out.length) cachePut(ctx, cacheKey, response.clone());
  return response;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Erreur interne du Worker : " + (e && e.message ? e.message : String(e)) }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
      });
    }
  },
};

async function handleRequest(request, env, ctx) {
  {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) return handleApi(url.pathname, request, env);

    if (url.searchParams.has("translate")) {
      return translateSummary(url.searchParams.get("translate"), url.searchParams.get("lang") || "fr", env, ctx);
    }

    if (url.searchParams.has("pack")) {
      return drawPack(url, env, ctx);
    }

    if (url.searchParams.has("anime")) {
      return getAnime(url, ctx);
    }

    if (url.searchParams.has("esport")) {
      return getEsport(url, env, ctx);
    }

    if (url.searchParams.has("reviews")) {
      return getReviews(url.searchParams.get("reviews"), env, url.searchParams.get("refresh") === "1");
    }

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

    const cacheKey = new Request(url.origin + "/v23" + url.search);
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    try {
      let games;

      if (searchQuery) {
        // ----- Recherche : tous les jeux, y compris rétro, toutes plateformes connues -----
        // 1) on récupère un grand lot de candidats (les jeux de fans sont nombreux)
        // 2) on garde les plus populaires et ceux dont le nom contient tous les mots
        // 3) on demande les détails de ces jeux seulement
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
        // ----- Liste d'un mois : sorties sur PC, PS5, Xbox, Switch 2 -----
        const [y, m] = month.split("-").map(Number);
        const start = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
        const end = Math.floor(Date.UTC(y, m, 1) / 1000);
        // Avant PS5 / Switch 2 (fin 2020), on affiche toutes les plateformes connues
        const platformIds = platformParam ? [FILTERS[platformParam]] : (month < "2020-11" ? Object.keys(PLATFORM_NAMES).map(Number) : MONTH_PLATFORMS);

        let where = `game_type = ${GAME_TYPES} & cover != null`;
        where += ` & release_dates.date >= ${start} & release_dates.date < ${end}`;
        where += ` & release_dates.platform = (${platformIds.join(",")})`;
        // Jeux populaires : très attendus, déjà notés, ou remakes / remasters (ex. Ocarina of Time)
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
  }
}
