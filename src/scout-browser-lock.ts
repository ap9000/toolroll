/**
 * The scout browser helper's pinned install (scout-browser.ts ensureScoutBrowserHelper): its manifest and lockfile,
 * generated once with `npm install --package-lock-only --registry https://registry.npmjs.org/` for @playwright/mcp
 * 0.0.82. `npm ci` installs exactly this tree and refuses any tarball whose sha512 differs. Changing a version here is
 * a supply-chain change: regenerate both and review the diff.
 */
export const SCOUT_BROWSER_MANIFEST = {
  "name": "toolroll-scout-browser",
  "private": true,
  "dependencies": {
    "@playwright/mcp": "0.0.82"
  }
} as const;

export const SCOUT_BROWSER_LOCK = {
  "name": "toolroll-scout-browser",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "toolroll-scout-browser",
      "dependencies": {
        "@playwright/mcp": "0.0.82"
      }
    },
    "node_modules/@playwright/mcp": {
      "version": "0.0.82",
      "resolved": "https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.82.tgz",
      "integrity": "sha512-OCqftfb8H4dnqm/njbTBRk3seUvUPttOlJUxCtEzXGETYOlRH5Qt3bbXIjmZIuWAxD9RF+yg1ASrPeXvm0y5cA==",
      "license": "Apache-2.0",
      "dependencies": {
        "playwright": "1.64.0-alpha-1789764292000",
        "playwright-core": "1.64.0-alpha-1789764292000"
      },
      "bin": {
        "playwright-mcp": "cli.js"
      },
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/playwright": {
      "version": "1.64.0-alpha-1789764292000",
      "resolved": "https://registry.npmjs.org/playwright/-/playwright-1.64.0-alpha-1789764292000.tgz",
      "integrity": "sha512-3Ngs4ERGdC912uW3srEDtNVey4u1wSaQ/EFcKhxMpz0by0K6nidaJgM087pLpJc1osytiVnL7ack5gvgPArPNw==",
      "license": "Apache-2.0",
      "dependencies": {
        "playwright-core": "1.64.0-alpha-1789764292000"
      },
      "bin": {
        "playwright": "cli.js"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/playwright-core": {
      "version": "1.64.0-alpha-1789764292000",
      "resolved": "https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.0-alpha-1789764292000.tgz",
      "integrity": "sha512-ZgRaybFv4rRy7QMGnYprEGFdNJnvapNqcaER2w96bDQA+40BWIle1el1Yh9KHD3E6XYmieMB+r+UxFTCauTGGQ==",
      "license": "Apache-2.0",
      "bin": {
        "playwright-core": "cli.js"
      },
      "engines": {
        "node": ">=20"
      }
    }
  }
} as const;
