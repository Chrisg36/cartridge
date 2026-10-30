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

// Langues de traduction (code de la page -> nom attendu par le modèle)
const TARGET_LANGS = { fr: "french", ja: "japanese", de: "german", es: "spanish", zh: "chinese", pt: "portuguese", ko: "korean", it: "italian" };

// Table D1 des traductions déjà faites (créée automatiquement la première fois)
let trTableReady = false;
async function ensureTrTable(env) {
  if (trTableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS translations (game_id INTEGER NOT NULL, lang TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (game_id, lang))"
  ).run();
  trTableReady = true;
}

// Traduction du résumé d'un jeu (anglais -> langue choisie)
// Ordre : cache Cloudflare -> base D1 -> traduction par l'IA (puis rangée dans D1)
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
      const row = await env.DB.prepare("SELECT summary FROM translations WHERE game_id = ? AND lang = ?")
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

    // 2) Sinon, on traduit morceau par morceau
    const out = [];
    for (const chunk of splitText(text)) {
      const r = await env.AI.run("@cf/meta/m2m100-1.2b", {
        text: chunk,
        source_lang: "english",
        target_lang: TARGET_LANGS[lang],
      });
      if (!r || !r.translated_text) throw new Error("Traduction vide renvoyée par l'IA");
      out.push(r.translated_text);
    }
    const summary = out.join(" ");

    // 3) On range la traduction dans D1 pour ne plus jamais la refaire
    if (env.DB && !dbError) {
      try {
        await env.DB.prepare("INSERT OR REPLACE INTO translations (game_id, lang, summary, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, lang, summary, Math.floor(Date.now() / 1000)).run();
      } catch (e) { dbError = e.message; }
    }

    const body = dbError ? { id, summary, db_error: dbError } : { id, summary, saved: false };
    return Response.json(body, { headers: dbError ? CORS : okHeaders });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: CORS });
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
    return jsonRes({ status: "created", token: await newSession(env, id) });
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
  return jsonRes({ status: "connected", token: await newSession(env, user.id), data: saved });
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

async function handleApi(path, request, env) {
  if (request.method !== "POST") return jsonRes({ error: "Méthode non autorisée." }, 405);
  if (!env.DB) return jsonRes({ error: "Base de données non reliée au Worker (binding DB manquant)." }, 500);
  try {
    if (path === "/api/auth") return await handleAuth(request, env);
    if (path === "/api/save") return await handleSave(request, env);
    if (path === "/api/recover") return await handleRecover(request, env);
    return jsonRes({ error: "Adresse inconnue." }, 404);
  } catch (e) {
    return jsonRes({ error: "Erreur du serveur." }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) return handleApi(url.pathname, request, env);

    if (url.searchParams.has("translate")) {
      return translateSummary(url.searchParams.get("translate"), url.searchParams.get("lang") || "fr", env, ctx);
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
  },
};
