import? 'justfile.local'

default:
    @just --list

# 1. Dependency Setup
setup:
    npm install
    nimble install --depsOnly -y

# 2. Test Suite Execution
test:
    nimble test
    npm run test

# 3. Linter Execution
lint:
    nph --check .
    nimble check
    npm run lint

# 4. Formatter Execution
fmt:
    nph .
    npm run fmt

# 5. Build Artifacts
build:
    npm run build

# 8. Clean Build Artifacts
clean:
    rm -rf nimcache htmldocs site docs/dist docs/.astro tools/docgen
    find . -name '*.exe' -delete

# 9. Secret Scanning
check-secrets:
    gitleaks detect -v

# 10. Upstream Template Synchronization
update-template:
    uvx copier update --trust
