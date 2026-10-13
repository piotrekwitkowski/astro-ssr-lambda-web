import type { APIContext } from 'astro';

// Shows what the app receives after CloudFront and the Lambda endpoint rewrite the request.
// Off unless the revision sets DEBUG_HEADERS=1, so the deployed sample doesn't echo headers.
export function GET({ request, url, clientAddress }: APIContext) {
	if (process.env.DEBUG_HEADERS !== '1') {
		return new Response(null, { status: 404 });
	}
	return Response.json({ url: url.href, clientAddress, headers: Object.fromEntries(request.headers) });
}
