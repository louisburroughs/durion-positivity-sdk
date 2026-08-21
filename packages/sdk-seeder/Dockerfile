# Seeder image for the accelerated alpha run.
#
# Build from the repository root, not from this directory — the seeder is a
# workspace package and npm ci needs the root lockfile and its sibling packages:
#
#   docker build -f packages/sdk-seeder/Dockerfile -t sdk-seeder:test .
#
# The image carries no credentials, URLs, clock anchors or environment
# identifiers. Everything the run needs is supplied at execution time, so the
# same immutable image can be run against any environment.

# Pinned by digest: a tag can be repointed, and an accelerated run must be
# reproducible from its recorded image alone.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# The seeder runs TypeScript through ts-node, which lives in devDependencies
# along with typescript itself. NODE_ENV=production would make npm omit them
# and the container would fail at startup, so it is deliberately not set here.
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    # The non-root user cannot write to npm's default cache location.
    npm_config_cache=/tmp/.npm

WORKDIR /app

# Manifests first so a source-only change reuses the install layer.
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages

# Install, then compile in dependency order.
#
# Every domain package's prepare step compiles sources that import
# @durion-sdk/transport, so transport's dist must exist before any of them runs.
# npm does not order workspace prepare steps that way, and it runs them during
# `npm ci` even under --ignore-scripts, so the install fails before anything can
# be built. Dropping prepare for the duration of the install and compiling
# explicitly afterwards makes the order deterministic. Only the copy of the
# manifests inside this image is touched.
RUN node -e "const fs=require('fs');for(const dir of fs.readdirSync('packages')){const file='packages/'+dir+'/package.json';if(!fs.existsSync(file))continue;const pkg=JSON.parse(fs.readFileSync(file,'utf8'));if(pkg.scripts&&pkg.scripts.prepare){delete pkg.scripts.prepare;fs.writeFileSync(file,JSON.stringify(pkg,null,2)+'\n');}}" \
    && npm ci \
    && npm run build -w packages/sdk-transport \
    && npm run build --workspaces --if-present

# node (uid 1000) ships with the base image. Ownership of /app stays with root:
# the seeder only reads its own sources, and a read-only application directory
# is one less thing a compromised run could rewrite.
USER node

# Fails fast and loudly when required configuration is absent — see
# SeederConfig, which rejects a missing SEEDER_USERNAME or SEEDER_PASSWORD
# before any network call is attempted.
CMD ["npm", "run", "seed", "-w", "packages/sdk-seeder"]
