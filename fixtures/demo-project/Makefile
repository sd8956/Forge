# Commands used by the Forge pipeline (see .factory/project.yaml).
PORT ?= 3000
EVIDENCE_DIR ?= test-results
JS := $(shell find src public scripts -name '*.js' -o -name '*.mjs')

.PHONY: up build lint unit check e2e

up: ## Start the app on $(PORT)
	PORT=$(PORT) node src/server.js

build: ## Syntax-check every source file
	@for f in $(JS); do node --check $$f || exit 1; done

lint: ## Project lint rules
	@node scripts/lint.mjs

unit: ## Unit tests
	@node --test test/

check: build lint unit ## What the development step must keep green

e2e: ## Playwright end-to-end tests (needs `npm install` and Chromium); make e2e EVIDENCE_DIR=<dir>
	EVIDENCE_DIR=$(EVIDENCE_DIR) npx playwright test
