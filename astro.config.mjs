// @ts-check

import node from '@astrojs/node';
import svelte from '@astrojs/svelte';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	adapter: node({
		mode: 'standalone',
	}),
	integrations: [svelte()],
	// Store Astro.session in DynamoDB. The default filesystem driver can't work on Web Functions:
	// the package is read-only and every execution environment has its own disk.
	session: { driver: { entrypoint: new URL('./src/session-driver.ts', import.meta.url) } },
	// Trust X-Forwarded-Host for CloudFront domains. The viewer-request CloudFront Function overwrites
	// it with the viewer's Host, so a value sent by the viewer never reaches Astro.
	security: { allowedDomains: [{ hostname: '*.cloudfront.net', protocol: 'https' }] },
	// Bundle dependencies into dist/server so the Web Function zip needs no node_modules.
	vite: { ssr: { noExternal: true } },
});
