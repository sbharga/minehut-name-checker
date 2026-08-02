# Minehut Name Checker

An app for checking Minehut server-name availability in bulk.

## Local development

```sh
npm ci
npm run dev
```

Run the automated checks with `npm test` and create a production build with
`npm run build`.

## GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` tests, builds, and deploys
the site whenever `main` is updated. It can also be run manually from the
Actions tab.

After pushing the repository to GitHub, open **Settings → Pages** and set
**Source** to **GitHub Actions**. The first successful workflow run will publish
the site at the URL shown in its `deploy` job.
