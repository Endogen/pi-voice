# Vendored Markdown parser

- Package: **markdown-it 15.0.3**
- License: **MIT**, included in `LICENSE`
- Upstream: https://github.com/markdown-it/markdown-it
- npm tarball: https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz
- Published tarball integrity (SHA-512, verified before extracting):
  `sha512-+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==`
- `markdown-it.min.js` is the unmodified browser UMD distribution, originally
  `package/dist/browser/markdown-it.umd.min.js` in that tarball.

`build.mjs` concatenates this parser and the two `src/` scripts into the existing
`public/app.js` asset. It omits the source-map reference; the source map is not
vendored. No CDN requests, runtime npm dependencies, or bundler are required.

Configuration/security: raw HTML disabled, web/mail/relative links only,
`noopener noreferrer` for links, no image fetches, disabled task checkboxes,
no syntax-highlighter HTML. Parser upgrades must be pinned, integrity-checked,
and followed by rebuilding and running the Markdown/XSS regression tests.
