# Astro SSR on AWS Lambda Web Functions behind Amazon CloudFront

This is Astro's [`examples/ssr`](https://github.com/withastro/astro/tree/59b9cc007264/examples/ssr) store,
imported at `withastro/astro@59b9cc0`, running on [AWS Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
in three Regions behind Amazon CloudFront. The imported app files are unchanged apart from three settings
added to `astro.config.mjs`. Everything AWS-specific lives in new files, so `git diff` against the first
commit shows exactly what it takes.

```text
viewer
  │  HTTPS
  ▼
CloudFront ── viewer-request function: Host → X-Forwarded-Host, drop viewer X-Forwarded-For
  │  origin access control (SigV4a, always-amz-auth)
  ▼
Lambda Web Function, MultiRegion endpoint (IamAuth)
  eu-west-1 (home) · us-east-1 · ap-northeast-1, routed by latency
  │  execution role
  ▼
DynamoDB global table for Astro.session, one replica per Region
```

## How it works

**Host and URLs.** A Web Function endpoint routes requests by `Host` and returns 404 for any other value,
so CloudFront sends the endpoint's own domain (origin request policy `AllViewerExceptHostHeader`). The
viewer-request CloudFront Function in `infra/viewer-request.js` copies the viewer's `Host` into
`X-Forwarded-Host`, overwriting anything the viewer sent. Astro trusts that header for `*.cloudfront.net`
(`security.allowedDomains`), so `Astro.url` is the public URL. Without it, Astro falls back to
`http://localhost:3000`.

**Access.** The endpoint uses `IamAuth`, so it rejects unsigned requests. CloudFront signs every origin
request with origin access control. The global endpoint needs SigV4a, and Web Function origins accept
only the `always-amz-auth` signing behavior, which puts CloudFront's signature in its own header and
passes the viewer's `Authorization` header through. The function's resource policy lets only this
distribution invoke the endpoint.

**Client IP.** CloudFront and the Lambda endpoint each append to `X-Forwarded-For`, and Astro reads the
first entry. The CloudFront Function drops the viewer's `X-Forwarded-For`, so the first entry is the
address CloudFront saw and `Astro.clientAddress` can't be spoofed.

**Sessions.** One endpoint runs many execution environments in three Regions, so the example's
in-memory cart (`src/models/session.ts`) would lose items between requests. `src/middleware.ts` loads
the user's cart from `Astro.session` before each request and saves it after. `src/session-driver.ts`
stores sessions in DynamoDB using the function's execution role. The SDK targets the Region the
function runs in, so every copy reads and writes its local replica.

**Code package.** Lambda reads the deployment package from a versioned S3 bucket with its own service
principal, so the stack creates a bucket whose policy allows `lambda.amazonaws.com` for this function's
revisions. Old packages stay in the bucket, because a revision fails permanently if its package is
deleted.

## Deploy

You need Node.js 24, AWS credentials, and an account where CDK is bootstrapped in the home Region
(`npx cdk bootstrap aws://ACCOUNT/eu-west-1`).

| Command | Action |
| :--- | :--- |
| `npm install` | Install dependencies |
| `npm run deploy` | Build the app, stage it in `.deploy/`, and deploy `infra/app.ts`. Prints the CloudFront URL |
| `npm run deploy -- -c debugHeaders=true` | Same, and turn on `/api/debug`, which returns the URL, client address, and headers the app receives |
| `npm run destroy` | Delete the stack, including the session table and code bucket |
| `npm run dev` | Run Astro locally. Browsing works without AWS. The cart needs `SESSION_TABLE` and AWS credentials |

The Regions are set at the top of `infra/app.ts`. The endpoint can't change Regions after it's created,
and all of them must be enabled by default, because CloudFront can't sign requests routed to opt-in
Regions.

## Project structure

```text
/
├── infra/
│   ├── app.ts                 # CDK stack (Node 24 runs it without a build step)
│   └── viewer-request.js      # CloudFront Function for X-Forwarded-Host and X-Forwarded-For
├── public/
├── src/
│   ├── components/
│   ├── models/
│   ├── pages/
│   │   ├── api/
│   │   │   └── debug.ts       # added: opt-in request echo
│   │   └── products/
│   ├── styles/
│   ├── api.ts
│   ├── middleware.ts          # added: backs the cart with Astro.session
│   └── session-driver.ts      # added: Astro session driver for DynamoDB
├── astro.config.mjs
├── server.ts                  # added: starts the Astro server on AWS_LAMBDA_HTTP_ENDPOINT
└── package.json
```

The app itself is the upstream example: Astro with the [`@astrojs/node`](https://docs.astro.build/en/guides/integrations-guide/node/)
adapter and [`@astrojs/svelte`](https://docs.astro.build/en/guides/integrations-guide/svelte/), rendering pages on
demand and serving API routes from `src/pages/api/`. See the [Astro docs](https://docs.astro.build) for the
framework itself.
