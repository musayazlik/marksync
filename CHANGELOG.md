# Changelog

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
