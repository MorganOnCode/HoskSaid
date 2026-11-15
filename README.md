This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## API rate limits

Run `npm test` for limiter regression checks. Anonymous requests have a 120-request
burst and refill at 60/minute by default. Only keys explicitly listed in
`HOSK_API_KEYS` receive the 600/minute tier. An absent or empty allowlist accepts no
bearer keys; unknown or empty bearer keys return `401 invalid_key`.

`TRUST_CLOUDFLARE_IP=true` uses the validated `CF-Connecting-IP` header. Enable it
only when public traffic must traverse Cloudflare; the production Compose service
does this with a loopback-only origin. Local users and containers with direct
origin access remain trusted. Without this setting, or with a missing/invalid
header, anonymous clients share one fallback bucket. `X-Forwarded-For` is ignored.
See [Cloudflare's header documentation](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

The in-process limiter retains at most 10,000 identities. At capacity, new
identities receive `429` with `Retry-After: 60`; existing allowances are preserved.
Idle, fully refilled buckets expire after five minutes, swept at most once per
minute on requests. Limits reset on process restart and are not shared across
replicas. These are request limits, not a provider spending cap.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
