import { defineMiddleware } from 'astro:middleware';
import { userCartItems } from './models/session';

// Back the in-memory cart with Astro.session: load this user's entry before the request,
// save it after. Web Functions don't share memory across execution environments or Regions.
export const onRequest = defineMiddleware(async ({ cookies, session }, next) => {
	const userId = cookies.get('user-id')?.value;
	if (!userId || !session) return next();
	userCartItems.set(userId, (await session.get('cart')) ?? new Map());
	const response = await next();
	session.set('cart', userCartItems.get(userId));
	return response;
});
