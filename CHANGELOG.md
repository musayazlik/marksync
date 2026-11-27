# Changelog

## [0.5.0](https://github.com/musayazlik/marksync/compare/v0.4.1...v0.5.0) (2026-11-27)


### Features

* **ai:** a monthly spending cap, and the OpenRouter balance and spending in the popup ([e8fb9ff](https://github.com/musayazlik/marksync/commit/e8fb9ff11cef23a2037c5d01d5493ef0014f6c37))
* **ai:** pick the model from OpenRouter's full list, with search, free and web-research filters and prices ([e8fb9ff](https://github.com/musayazlik/marksync/commit/e8fb9ff11cef23a2037c5d01d5493ef0014f6c37))
* **ai:** sort a whole existing folder with a review-and-approve preview ([e8fb9ff](https://github.com/musayazlik/marksync/commit/e8fb9ff11cef23a2037c5d01d5493ef0014f6c37))
* **ai:** sort with your own OpenAI-compatible server or the browser's built-in model ([b547239](https://github.com/musayazlik/marksync/commit/b547239384779a773c473e77591c12abb14b4cad)), closes [#10](https://github.com/musayazlik/marksync/issues/10)
* **backups:** version history with a diff view and per-item restore ([c61ff41](https://github.com/musayazlik/marksync/commit/c61ff4112c6182d35ea202b1986d7242488ff250)), closes [#8](https://github.com/musayazlik/marksync/issues/8)
* **popup:** instant search across all bookmarks, including what AI sorting learned about each site ([e8fb9ff](https://github.com/musayazlik/marksync/commit/e8fb9ff11cef23a2037c5d01d5493ef0014f6c37))
* **sync:** optional end-to-end encryption of everything Marksync keeps in Drive ([e8fb9ff](https://github.com/musayazlik/marksync/commit/e8fb9ff11cef23a2037c5d01d5493ef0014f6c37))
* **ui:** the account address is masked on screen until clicked ([e8fb9ff](https://github.com/musayazlik/marksync/commit/e8fb9ff11cef23a2037c5d01d5493ef0014f6c37))

## [0.4.1](https://github.com/musayazlik/marksync/compare/v0.4.0...v0.4.1) (2026-11-25)


### Changes

* new Marksync logo ([c6879f3](https://github.com/musayazlik/marksync/commit/c6879f3bd7743f7b257e22cc17a23c2303cbed82))

## [0.4.0](https://github.com/musayazlik/marksync/compare/v0.3.0...v0.4.0) (2026-11-24)


### Features

* check bookmarks for dead links and offer the Wayback Machine copy ([a107e09](https://github.com/musayazlik/marksync/commit/a107e09482b334f519f145e99ae2bfc53c80e755)), closes [#7](https://github.com/musayazlik/marksync/issues/7)
* find duplicate bookmarks and keep one copy of each ([ac7d597](https://github.com/musayazlik/marksync/commit/ac7d597bd2630c8a319bfd34c713df1a7eee5647)), closes [#6](https://github.com/musayazlik/marksync/issues/6)

## [0.3.0](https://github.com/musayazlik/marksync/compare/v0.2.0...v0.3.0) (2026-11-24)


### Features

* **ai:** file bookmarks from an inbox folder with OpenRouter ([426a61c](https://github.com/musayazlik/marksync/commit/426a61cac9e58cb1738dfc4a7f902cdd03c263a6))
* **ai:** research each site on the web and describe it in the sorting log ([6fb3f3b](https://github.com/musayazlik/marksync/commit/6fb3f3b1aa7b48953b82ee93772118e3fd2246fb))
* **ui:** new look for Settings, the popup and the sorting log, with an animated sync status ([6fb3f3b](https://github.com/musayazlik/marksync/commit/6fb3f3b1aa7b48953b82ee93772118e3fd2246fb))
* **ui:** the sorting log is a timeline grouped by day, with filter counts and a route from the inbox to the new folder ([6fb3f3b](https://github.com/musayazlik/marksync/commit/6fb3f3b1aa7b48953b82ee93772118e3fd2246fb))

## [0.2.0](https://github.com/musayazlik/marksync/compare/v0.1.0...v0.2.0) (2026-11-23)


### Features

* **i18n:** English and Turkish interface ([c9154ec](https://github.com/musayazlik/marksync/commit/c9154ec1be2fe0c9d62cd11305ecc41c8ae6e29b))
* open Settings with a welcome note after the first install ([c9154ec](https://github.com/musayazlik/marksync/commit/c9154ec1be2fe0c9d62cd11305ecc41c8ae6e29b))
* **options:** show the version, linked to its release notes ([7bd78b4](https://github.com/musayazlik/marksync/commit/7bd78b4cd19ce9a2735c6fd532e6577412bd053d))
* show a badge on the toolbar icon when sync needs attention ([c9154ec](https://github.com/musayazlik/marksync/commit/c9154ec1be2fe0c9d62cd11305ecc41c8ae6e29b))


### Bug Fixes

* **auth:** keep other browsers connected when one disconnects ([9dfe354](https://github.com/musayazlik/marksync/commit/9dfe3546a91b2bfa4ffe40003cc72bd1d80a55bf))
* **options:** reload backups and browsers after connecting from the popup ([c9154ec](https://github.com/musayazlik/marksync/commit/c9154ec1be2fe0c9d62cd11305ecc41c8ae6e29b))
* Sync now no longer syncs while sync is turned off for the browser ([c9154ec](https://github.com/musayazlik/marksync/commit/c9154ec1be2fe0c9d62cd11305ecc41c8ae6e29b))

## 0.1.0 (2026-11-22)

### Features

* First release: two-way bookmark sync between Chromium browsers (Chrome, Brave, Edge, Opera and others) and Firefox through a Marksync folder in your own Google Drive
* Conflict handling per field, no duplicates when a browser with the same bookmarks connects, and a safety stop before large deletions
* Automatic and manual backups in Google Drive with one-click restore
* Import from other browsers with Marksync or from any browser's HTML export, and export to a standard HTML file
