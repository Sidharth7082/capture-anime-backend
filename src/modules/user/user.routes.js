// User routes — all require a valid access token.
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { createUserController } from './user.controller.js';
import {
  favoritesQuery,
  addFavoriteBody,
  favoriteIdParams,
  historyQuery,
  historyBody,
  continueWatchingParams,
  saveContinueWatchingBody,
} from './user.schemas.js';

export function createUserRouter({ userService }) {
  const router = Router();
  const controller = createUserController(userService);

  router.use(authenticate);

  router.get('/profile', controller.profile);
  router.get('/favorites', validate({ query: favoritesQuery }), controller.listFavorites);
  router.post('/favorites', validate({ body: addFavoriteBody }), controller.addFavorite);
  router.delete(
    '/favorites/:id',
    validate({ params: favoriteIdParams }),
    controller.removeFavorite,
  );
  router.get('/history', validate({ query: historyQuery }), controller.history);
  router.post('/history', validate({ body: historyBody }), controller.addHistory);

  router.get(
    '/continue-watching',
    validate({ query: favoritesQuery }),
    controller.listContinueWatching,
  );
  router.put(
    '/continue-watching/:animeId',
    validate({ params: continueWatchingParams, body: saveContinueWatchingBody }),
    controller.saveContinueWatching,
  );
  router.delete(
    '/continue-watching/:animeId',
    validate({ params: continueWatchingParams }),
    controller.removeContinueWatching,
  );

  return router;
}
