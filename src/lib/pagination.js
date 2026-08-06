// Pagination helpers shared by every list endpoint.
export function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const limit = Number.parseInt(query.limit ?? String(defaultLimit), 10);

  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const safeLimit =
    Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), maxLimit) : defaultLimit;

  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

export function buildPaginationMeta({ page, limit, total }) {
  const totalPages = total === 0 ? 0 : Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
  };
}

export function paginate(query, options) {
  const { page, limit, offset } = parsePagination(query, options);
  return { page, limit, offset };
}
