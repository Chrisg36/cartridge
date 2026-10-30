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
