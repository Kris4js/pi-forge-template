.PHONY: install dev down status gateway web build test check docker

install:            ## npm workspaces + go modules + document parser
	npm install
	cd gateway && go mod download
	@if command -v uv >/dev/null 2>&1; then \
		uv venv --python 3.12 --allow-existing .venv && \
		uv pip install --python .venv/bin/python -r packages/documents/requirements.txt; \
	else \
		python3 -m venv .venv && \
		.venv/bin/python -m pip install -r packages/documents/requirements.txt; \
	fi

gateway:            ## build the Go gateway into bin/
	cd gateway && go build -o ../bin/gateway ./cmd/gateway

dev: gateway        ## gateway + TS runtime on :8090 and Vite on :5173
	node scripts/dev.mjs

down:               ## stop the services started by make dev
	node scripts/dev.mjs down

status:             ## show the processes managed by make dev
	node scripts/dev.mjs status

web:                ## Vite dev server on :5173, proxies /v1 to the gateway
	npm run dev -w web

build: gateway      ## production build: gateway binary + web/dist (serve with FORGE_WEB_DIR=web/dist)
	npm run build -w web

test:
	cd gateway && go test -race ./...
	npm test -w runtime

check:
	cd gateway && go vet ./...
	npm run check

docker:
	docker compose up -d --build
