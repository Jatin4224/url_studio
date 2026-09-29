# URL Studio — web

The URL Studio landing page, presentation UI and admin log viewer.

```sh
npm install
npm run dev   # http://localhost:3000
```

Submitting a URL calls `POST /api/presentations`, which proxies to the worker in
[../workers/](../workers/). Set `WORKER_URL` in `.env.local` or the page will show
"The studio is temporarily unavailable".

See the [root README](../READ.MD) for the full pipeline, configuration and setup.
