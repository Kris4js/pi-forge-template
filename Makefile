.PHONY: install dev gateway web build test check docker

install:            ## npm workspaces + go modules
	npm install
	cd gateway && go mod download

gateway:            ## build the Go gateway into bin/
	cd gateway && go build -o ../bin/gateway ./cmd/gateway

dev: gateway        ## gateway on :8090 (spawns the TS runtime); run `make web` in another shell
	./bin/gateway

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
