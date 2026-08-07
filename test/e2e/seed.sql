-- E2E seed: a small but complete catalog so every read endpoint returns data.
INSERT INTO genres (name) VALUES ('Action'), ('Comedy'), ('Sci-Fi'), ('Drama');
INSERT INTO studios (name, is_animation_studio) VALUES ('Sunrise', TRUE), ('Bones', TRUE);

INSERT INTO anime
  (anilist_id, id_mal, title_romaji, title_english, title_native, synonyms, description,
   media_type, format, status, episodes, duration_minutes, start_date, end_date,
   season, season_year, average_score, mean_score, popularity, favourites, source,
   is_adult, cover_image_large, cover_image_medium, banner_image, slug, last_synced_at)
VALUES
  (1, 1, 'Cowboy Bebop', 'Cowboy Bebop', 'カウボーイビバップ', '{CB}', '<p>Space bounty hunters.</p>',
   'ANIME', 'TV', 'FINISHED', 26, 24, '1998-04-03', '1999-04-24', 'SPRING', 1998, 86, 85, 100000, 50000, 'ORIGINAL', FALSE,
   'https://img.example/cb_large.jpg', 'https://img.example/cb_med.jpg', 'https://img.example/cb_banner.jpg',
   'anime-1', now()),
  (2, 5, 'Cowboy Bebop: Knockin'' on Heaven''s Door', 'Cowboy Bebop: The Movie', 'カウボーイビバップ 天国の扉', '{}', '<p>Movie.</p>',
   'ANIME', 'MOVIE', 'FINISHED', 1, 115, '2001-09-01', '2001-09-01', 'FALL', 2001, 82, 80, 40000, 15000, 'ORIGINAL', FALSE,
   'https://img.example/cbm_large.jpg', 'https://img.example/cbm_med.jpg', NULL,
   'anime-5', now()),
  (3, 205, 'Samurai Champloo', 'Samurai Champloo', 'サムライチャンプルー', '{}', '<p>Hip-hop samurai.</p>',
   'ANIME', 'TV', 'FINISHED', 26, 24, '2004-05-20', '2005-03-19', 'SPRING', 2004, 84, 83, 90000, 40000, 'ORIGINAL', FALSE,
   'https://img.example/sc_large.jpg', 'https://img.example/sc_med.jpg', NULL,
   'anime-205', now()),
  (4, 21, 'One Piece', 'One Piece', 'ワンピース', '{}', '<p>Pirates.</p>',
   'ANIME', 'TV', 'RELEASING', 1100, 24, '1999-10-20', NULL, 'FALL', 1999, 80, 78, 300000, 120000, 'MANGA', FALSE,
   'https://img.example/op_large.jpg', 'https://img.example/op_med.jpg', NULL,
   'anime-21', now()),
  (5, 1535, 'Death Note', 'Death Note', 'デスノート', '{}', '<p>Death god notebook.</p>',
   'ANIME', 'TV', 'FINISHED', 37, 23, '2006-10-04', '2007-06-27', 'FALL', 2006, 84, 82, 250000, 90000, 'MANGA', FALSE,
   'https://img.example/dn_large.jpg', 'https://img.example/dn_med.jpg', NULL,
   'anime-1535', now()),
  (6, 999, 'Seiso High', 'Seiso High', '清楚ハイ', '{}', '<p>Adult.</p>',
   'ANIME', 'TV', 'FINISHED', 12, 24, '2020-01-10', '2020-03-27', 'WINTER', 2020, 60, 55, 1000, 200, 'MANGA', TRUE,
   'https://img.example/sh_large.jpg', 'https://img.example/sh_med.jpg', NULL,
   'anime-999', now());

INSERT INTO anime_genres (anime_id, genre_id) VALUES
  (1, 1), (1, 3), (1, 4), (2, 3), (3, 1), (4, 1), (5, 4), (6, 2);

INSERT INTO anime_studios (anime_id, studio_id, is_main) VALUES
  (1, 1, TRUE), (2, 1, TRUE), (3, 2, TRUE), (4, 2, TRUE);

INSERT INTO characters (anilist_id, name_first, name_last, name_native, image_large, image_medium, favourites) VALUES
  (101, 'Spike', 'Spiegel', 'スパイク・スピーゲル', 'https://img.example/spike.jpg', 'https://img.example/spike_med.jpg', 9000),
  (102, 'Jet', 'Black', 'ジェット・ブラック', 'https://img.example/jet.jpg', 'https://img.example/jet_med.jpg', 5000),
  (103, 'Faye', 'Valentine', 'フェイ・ヴァレンタイン', 'https://img.example/faye.jpg', 'https://img.example/faye_med.jpg', 8000),
  (104, 'Edward', 'Wong', 'エドワード・ウォン', 'https://img.example/ed.jpg', 'https://img.example/ed_med.jpg', 6000);

INSERT INTO anime_characters (anime_id, character_id, role, sort_order) VALUES
  (1, 1, 'MAIN', 0), (1, 2, 'MAIN', 1), (1, 3, 'SUPPORTING', 0), (1, 4, 'SUPPORTING', 1);

INSERT INTO staff (anilist_id, name_first, name_last, name_native, language, image_large) VALUES
  (201, 'Kōichi', 'Yamadera', '山寺宏一', 'Japanese', 'https://img.example/yamadera.jpg'),
  (202, 'Steve', 'Blum', NULL, 'English', 'https://img.example/blum.jpg'),
  (203, 'Yoko', 'Kanno', '菅野よう子', 'Japanese', 'https://img.example/kanno.jpg'),
  (204, 'Shinichirō', 'Watanabe', '渡辺信一郎', 'Japanese', 'https://img.example/watanabe.jpg');

INSERT INTO character_staff (character_id, staff_id, language) VALUES
  (1, 1, 'Japanese'), (1, 2, 'English'), (2, 1, 'Japanese');

INSERT INTO anime_staff (anime_id, staff_id, positions) VALUES
  (1, 4, '{Director}'), (1, 3, '{Music}');

INSERT INTO episodes (anilist_id, anime_id, number, title, title_japanese, synopsis, thumbnail_url, duration_seconds, air_date, is_filler, is_recap, video_url) VALUES
  (1001, 1, 1, 'Asteroid Blues', 'アステロイド・ブルース', 'Synopsis 1.', 'https://img.example/ep1.jpg', 1440, '1998-04-03', FALSE, FALSE, 'https://cdn.example/ep1.m3u8'),
  (1002, 1, 2, 'Stray Dog Strut', '野良犬のストラット', 'Synopsis 2.', 'https://img.example/ep2.jpg', 1440, '1998-04-10', FALSE, FALSE, 'https://cdn.example/ep2.m3u8'),
  (1003, 1, 3, 'Honky Tonk Women', 'ホンキィ・トンク・ウィメン', 'Synopsis 3.', 'https://img.example/ep3.jpg', 1440, '1998-04-17', FALSE, FALSE, NULL),
  (1004, 4, 1, 'I''m Luffy!', '俺はルフィ！', 'Pilot.', 'https://img.example/op1.jpg', 1440, '1999-10-20', FALSE, FALSE, 'https://cdn.example/op1.m3u8'),
  (1005, 4, 2, 'Pirate Hunter', '海賊狩り', 'Zoro.', 'https://img.example/op2.jpg', 1440, '1999-10-27', FALSE, FALSE, NULL);

INSERT INTO anime_relations (anime_id, related_anime_id, mal_id, media_type, name, relation, sort_order) VALUES
  (1, 2, 5, 'anime', 'Cowboy Bebop: The Movie', 'Side story', 0),
  (1, NULL, 555, 'manga', 'Cowboy Bebop Manga', 'Alternative version', 1);

INSERT INTO anime_recommendations (anime_id, recommended_anime_id, mal_id, title, votes, sort_order) VALUES
  (1, 4, 21, 'One Piece', 500, 0),
  (1, 5, 1535, 'Death Note', 300, 1),
  (1, NULL, 12345, 'Outer Anime', 10, 2);

INSERT INTO anime_pictures (anime_id, image_url, large_image_url, webp_url, sort_order) VALUES
  (1, 'https://img.example/p1.jpg', 'https://img.example/p1_l.jpg', 'https://img.example/p1.webp', 0),
  (1, 'https://img.example/p2.jpg', 'https://img.example/p2_l.jpg', 'https://img.example/p2.webp', 1);

INSERT INTO anime_videos (anime_id, kind, youtube_id, title, url, embed_url, thumbnail_large, episode_number, sort_order) VALUES
  (1, 'promo', 'abc123', 'PV', 'https://youtu.be/abc123', 'https://www.youtube.com/embed/abc123', 'https://img.example/pv.jpg', NULL, 0),
  (1, 'episode', 'def456', 'Episode 1', 'https://youtu.be/def456', 'https://www.youtube.com/embed/def456', 'https://img.example/epv.jpg', 1, 1);

INSERT INTO producers (name) VALUES ('Bandai Visual');
INSERT INTO licensors (name) VALUES ('Funimation');
INSERT INTO themes (name) VALUES ('Space');
INSERT INTO demographics (name) VALUES ('Seinen');
INSERT INTO anime_producers (anime_id, producer_id) VALUES (1, 1);
INSERT INTO anime_licensors (anime_id, licensor_id) VALUES (1, 1);
INSERT INTO anime_themes (anime_id, theme_id) VALUES (1, 1);
INSERT INTO anime_demographics (anime_id, demographic_id) VALUES (1, 1);

-- One seeded user (password: "E2EPassword1!", bcrypt hash created by the E2E script itself is
-- impractical at SQL level — the suite registers fresh users via the API; this row only exists
-- to satisfy FK references in write tests that need a pre-existing user).
SELECT 'seed complete' AS status;
