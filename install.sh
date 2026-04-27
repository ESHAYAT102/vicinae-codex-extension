#!/bin/bash

# Install bun if not already installed
if ! command -v bun &> /dev/null; then
    curl -fsSL https://bun.sh/install | bash
fi

# Clone the repository
git clone https://github.com/ESHAYAT102/vicinae-codex-extension.git

# Navigate into the directory
cd vicinae-codex-extension

# Install dependencies and build
bun i
bun run build

# Go back and remove the directory
cd ..
rm -rf vicinae-codex-extension
