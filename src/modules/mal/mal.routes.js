import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { createMalController } from './mal.controller.js';
import {
  malCallbackQuery,
  malListQuery,
  malUpdateBody,
  malAddBody,
  malProgressBody,
  malAnimeIdParams,
} from './mal.schemas.js';

export function createMalRouter({ malService }) {
  const router = Router();
  const controller = createMalController(malService);

  // Browser OAuth flow — no JWT (MAL redirects here).
  router.get('/connect', authenticate, controller.connect);
  router.get('/callback', validate({ query: malCallbackQuery }), controller.callback);

  // Everything below requires the backend JWT.
  router.use(authenticate);

  router.get('/me', controller.me);
  router.post('/disconnect', controller.disconnect);
  router.post('/sync', controller.sync);
  router.get('/list', validate({ query: malListQuery }), controller.list);
  router.post('/list', validate({ body: malAddBody }), controller.add);
  router.put(
    '/list/:malAnimeId',
    validate({ params: malAnimeIdParams, body: malUpdateBody }),
    controller.update,
  );
  router.delete('/list/:malAnimeId', validate({ params: malAnimeIdParams }), controller.remove);
  router.post('/progress', validate({ body: malProgressBody }), controller.progress);

  return router;
}
