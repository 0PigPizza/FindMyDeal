# FindMyDeal

Run `npm install` and `npm start`, then open http://localhost:3000. MariaDB must be installed on the machine; the project starts its own local database and keeps its data in `.data/`.

Monitors search their selected sources while the app is running, using each marketplace's default location. Each source checks up to the monitor's item limit (maximum 30) per run and saves found listings under Deals. Marketplaces search in parallel. Each marketplace searches one monitor at a time and uses the same adjustable delay between search starts. Stopping all monitors resets the normal delay; marketplace blocks still apply. Low, normal, and high priorities receive search turns in a 1:2:4 ratio within each marketplace when they are all eligible. Each search loads at most three listing pages in parallel. If a source needs sign-in or a filter is unsupported, the monitor card shows the error. For a distance filter, eBay needs a default postal code saved in its source browser and a supported distance.

eBay monitors use eBay.ca, with search price limits and distances in Canadian dollars and kilometres. Prices explicitly shown in US dollars are converted using the Bank of Canada's daily exchange rate. eBay search results are used to reuse recently fetched details for unchanged listings; full details are refreshed after 24 hours or when the result card changes. Listing pages are fetched one at a time.

Monitor keyword, condition, price-presence, and photo filters apply to saved and newly found listings. Keywords are comma-separated phrases and can be matched against titles or titles and descriptions. Selecting a condition hides listings where the marketplace does not report one; older listings acquire a condition when found again.

Items contains every listing found for each monitor. Deals contains listings that pass the monitor filters and an AI review. Configure the free OpenRouter model and general instructions in AI, add monitor-specific instructions while editing a monitor, or add a prompt to an individual item in Items. The API key is stored in the project-local `.data/` directory. Listing details and prompts are sent to OpenRouter; reviews can be wrong and free models have request limits. Items remain visible while reviews are pending or unavailable.

Sources opens a private project-local Firefox profile for each marketplace through VNC. Sign in yourself and choose Done; the profile is reused the next time you open that source. The app cannot verify whether a marketplace keeps you signed in. The browser runtime is downloaded into `.data/` on first start on Arch-based systems.

Alerts can send newly AI-approved deals to Discord or Telegram while the app is running. In Alerts, connect a Discord channel webhook or a Telegram bot token and chat ID; a test message confirms the connection. For Telegram, create a bot with BotFather and start a chat with it (or add it to a group) before connecting. Credentials are stored in the project-local `.data/` directory. Alerts are sent once when a listing becomes a deal; failed deliveries are not retried.

## Updates

The Updates page checks the `main` branch of the public [FindMyDeal repository](https://github.com/0PigPizza/FindMyDeal). Checks run shortly after startup and every six hours while the app is running; you can also check immediately from the page. Automatic installation is enabled by default and can be turned off there. The setting is kept in `.data/`.

When an update is available, the app only fast-forwards a clean `main` checkout whose `origin` points to the project repository. It installs the locked Node dependencies and restarts the app when launched with `npm start`. Local modifications, untracked files, a different branch or divergent history prevent automatic installation. Commit or move local changes, or update manually. If dependency installation fails, the app reports the error and retries on a later check; inspect the console and run `npm ci` if necessary. Project-local data in `.data/` is not part of the update.

## Docker release

Download `findmydeal-images-linux-amd64.tar.gz`, `compose.yaml`, and `env.example` from the [latest release](https://github.com/0PigPizza/FindMyDeal/releases/latest). These images are for Linux x86-64 hosts. In the download directory:

```sh
docker load -i findmydeal-images-linux-amd64.tar.gz
cp env.example .env
# Edit .env and set two different, long random passwords.
docker compose up -d
```

Open http://localhost:3000. The bundled MariaDB has no published port; the app is published only on localhost. Named Docker volumes hold the database and the app's profiles and credentials across restarts. The application initializes its own schema on startup, so no separate SQL import is required. This Docker database is independent of a pre-existing `.data/mariadb` installation. Back up both volumes before changing releases; do not use `docker compose down -v` unless you intend to delete the data. Stop and back up the database consistently before copying its volume.

For a new container release, download and load its images, then run `docker compose up -d --force-recreate`. Keep the existing `.env` and volumes. In a container, Updates checks for releases but does not replace its own running image. GitHub automatically includes source archive links on releases in addition to the supplied container files.

The **Update now** button installs an available update even when automatic updates are disabled. Container installations can enable this button by running the host-side `scripts/container-updater.js` helper as a service, with arguments pointing to the Compose directory and a shared update-control directory mounted at `/app/.data/update-control` in the app container. Configure the app image as `findmydeal:latest`. The helper downloads the latest release, checks its published SHA-256 checksum, loads the images, and recreates only the app service. It requires Docker access; protect the helper and its service configuration from modification by untrusted users. Without the helper, install container updates through Compose as described above.
