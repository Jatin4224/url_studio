# URL Studio — starter

The complete URL Studio landing page and presentation UI, with **no backend connected**.

```sh
npm install
npm run dev   # http://localhost:3000
```

Everything visual is here: the landing page sections, the URL input, the progress view and the result
player. Submitting a URL calls `POST /api/presentations`, which does not exist yet, so the page shows
"Could not connect to the studio". That route, the worker that generates the presentation, storage and
monitoring are what we build next.

# url_studio
