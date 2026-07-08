# The Opportunity Explorer deploy is a pure static client-side bundle.
#
# A Dockerfile at the repo root makes Railway build with Docker instead of
# Nixpacks — this is deliberate. Nixpacks would treat the repo as a Node
# service and run `npm ci`, which pulls the dev-only, native-binary deps
# (`onnxruntime-node`, `sharp`) whose install-time downloads break the build.
# None of that is needed to serve static files, so we copy just the runtime
# bundle and run a tiny zero-dependency server. No `npm install` happens here.
FROM node:22-alpine
WORKDIR /app

# Only the files the browser actually loads (see index.html). Deliberately
# excludes node_modules, the .mjs build tooling, app.db, and caches.
COPY static-server.mjs ./
COPY index.html data.js enrichment.js facets.js vectors.bin vectors-meta.json ./
COPY assets ./assets

# Railway injects $PORT at runtime; static-server.mjs honors it (default 8080).
EXPOSE 8080
CMD ["node", "static-server.mjs"]
