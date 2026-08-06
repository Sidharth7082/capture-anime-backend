// User HTTP handlers (authenticated).
import { asyncHandler } from '../../lib/async-handler.js';

export function createUserController(userService) {
  const userId = (req) => req.user.sub;

  return {
    profile: asyncHandler(async (req, res) => res.json(await userService.getProfile(userId(req)))),

    listFavorites: asyncHandler(async (req, res) =>
      res.json(await userService.listFavorites(userId(req), req.query)),
    ),

    addFavorite: asyncHandler(async (req, res) => {
      const favorite = await userService.addFavorite(userId(req), req.body);
      res.status(favorite.created ? 201 : 200).json({ favorite });
    }),

    removeFavorite: asyncHandler(async (req, res) =>
      res.json(await userService.removeFavorite(userId(req), req.params.id)),
    ),

    history: asyncHandler(async (req, res) =>
      res.json(await userService.listHistory(userId(req), req.query)),
    ),

    addHistory: asyncHandler(async (req, res) => {
      const result = await userService.addHistory(userId(req), req.body);
      res.json(result);
    }),

    listContinueWatching: asyncHandler(async (req, res) =>
      res.json(await userService.listContinueWatching(userId(req), req.query)),
    ),

    saveContinueWatching: asyncHandler(async (req, res) => {
      const result = await userService.saveContinueWatching(userId(req), req.params.animeId, req.body);
      res.json(result);
    }),

    removeContinueWatching: asyncHandler(async (req, res) =>
      res.json(await userService.removeContinueWatching(userId(req), req.params.animeId)),
    ),
  };
}
