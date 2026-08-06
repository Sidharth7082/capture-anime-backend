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

  return router;
}
